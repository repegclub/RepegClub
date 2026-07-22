use cosmwasm_std::{
    from_json, Addr, BankMsg, Coin, CosmosMsg, DepsMut, Env, MessageInfo, Response, Timestamp,
    Uint128, WasmMsg,
};
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};

use crate::error::ContractError;
use crate::msg::Cw20HookMsg;
use crate::rand::pick_winner_index;
use crate::state::{Config, PrizeAsset, RaffleState, RaffleStatus, RaffleType, AIRDROP_CLAIMS, CONFIG, RAFFLE};

const FEE_SPLIT_BPS: u128 = 5000; // 50/50 founder/treasury, dust to treasury (see draw_winner)
const FEE_SPLIT_DENOM: u128 = 10000;

/// Caps how many times `DrawWinner` can rearm (see the "past the window"
/// branch below) before two things happen at once: (1) anyone, not just the
/// creator, is authorized to call `DrawWinner`, instead of waiting the full
/// `unclaimed_deadline_days`; and (2) rearming itself stops - the next
/// eligible call draws immediately, at whatever height it lands on, instead
/// of resetting the window again. Both halves matter: (1) alone (an earlier,
/// buggy version of this fix) only *permitted* someone else to draw - it
/// never actually stopped the creator from rearming, so if no one else
/// happened to call `DrawWinner` in the meantime, the creator could keep
/// re-arming forever regardless of the cap (found by an Opus+Fable review,
/// 2026-07-22, of that first version). Without (2), a creator willing to run
/// a script could sit on the free, no-cost rearm loop indefinitely: watch
/// each new block within the window, compute off-chain (same public
/// SHA-256) if it favors them, and if not just let the window lapse and
/// rearm again - no validator collusion needed, just patience. Over
/// `unclaimed_deadline_days` (up to 365, creator-chosen) that's potentially
/// hundreds of thousands of free samples. Capping rearms at 2 - and actually
/// forcing the draw once the cap is spent - bounds it to a couple hundred at
/// most: still not zero (no block-based randomness scheme is, see rand.rs),
/// but a dramatic reduction, and a real creator drawing in good faith has no
/// reason to ever hit this limit in the first place. Alongside folding the
/// max-players sellout draw into the same atomic transaction as the closing
/// ticket purchase (see `execute_buy_ticket`), which removes this grinding
/// surface entirely for that path.
const MAX_REARMS_BEFORE_PERMISSIONLESS: u32 = 2;

/// Runs the actual winner-selection + payout logic, shared by the two paths
/// that can trigger a draw: `execute_buy_ticket`'s sellout auto-draw (same
/// atomic transaction as the closing ticket, no separate window to grind)
/// and `execute_draw_winner`'s manual path (for raffles that close via
/// timeout instead of selling out). Mutates `raffle` in place and returns
/// the payout messages; the caller is responsible for saving state.
fn perform_draw(config: &Config, raffle: &mut RaffleState, height: u64, time: Timestamp) -> Vec<CosmosMsg> {
    let mut messages: Vec<CosmosMsg> = vec![];

    match config.raffle_type {
        RaffleType::SingleWinner => {
            let idx = pick_winner_index(0, height, time.nanos(), 0, &raffle.entrants);
            let winner = raffle.entrants[idx].clone();
            raffle.winners = vec![winner.clone()];
            raffle.prize_shares = vec![raffle.prize_amount];
            messages.push(prize_transfer_msg(&config.prize_asset, &winner, raffle.prize_amount));
        }
        RaffleType::Podium => {
            let mut winners: Vec<Addr> = vec![];
            let mut pool = raffle.entrants.clone();
            for place in 0..config.podium_shares_bps.len() as u64 {
                let idx = pick_winner_index(0, height, time.nanos(), place, &pool);
                let winner = pool[idx].clone();
                winners.push(winner.clone());
                pool.retain(|e| *e != winner);
            }

            const PODIUM_DENOM: u128 = 10_000;
            let allocated: Uint128 = config
                .podium_shares_bps
                .iter()
                .map(|bps| raffle.prize_amount.multiply_ratio(*bps as u128, PODIUM_DENOM))
                .sum();
            let mut shares: Vec<Uint128> = config
                .podium_shares_bps
                .iter()
                .map(|bps| raffle.prize_amount.multiply_ratio(*bps as u128, PODIUM_DENOM))
                .collect();
            shares[0] += raffle.prize_amount.checked_sub(allocated).unwrap_or_default();

            for (winner, share) in winners.iter().zip(shares.iter()) {
                if !share.is_zero() {
                    messages.push(prize_transfer_msg(&config.prize_asset, winner, *share));
                }
            }
            raffle.winners = winners;
            raffle.prize_shares = shares;
        }
        RaffleType::Airdrop => {
            raffle.airdrop_share = raffle
                .prize_amount
                .multiply_ratio(1u128, raffle.unique_players.len() as u128);
        }
    }

    if !raffle.ticket_revenue.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.creator.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: raffle.ticket_revenue,
                }],
            }
            .into(),
        );
    }

    if !raffle.fee_amount.is_zero() {
        let founder_cut = raffle.fee_amount.multiply_ratio(FEE_SPLIT_BPS, FEE_SPLIT_DENOM);
        let treasury_cut = raffle.fee_amount.checked_sub(founder_cut).unwrap_or_default();

        for (addr, amount) in [
            (&config.founder_fee_address, founder_cut),
            (&config.treasury_address, treasury_cut),
        ] {
            if !amount.is_zero() {
                messages.push(
                    BankMsg::Send {
                        to_address: addr.to_string(),
                        amount: vec![Coin {
                            denom: config.usdc_denom.clone(),
                            amount,
                        }],
                    }
                    .into(),
                );
            }
        }
    }

    raffle.status = RaffleStatus::Drawn;
    raffle.drawn_at = Some(time);
    raffle.draw_height = Some(height);

    messages
}

/// Rejects any attached coin whose denom isn't in `allowed` - otherwise an
/// unrelated coin sent by mistake (wrong wallet UI, fat-fingered denom) would
/// be silently absorbed by the contract with no sweep mechanism to recover it.
fn reject_unexpected_funds(funds: &[Coin], allowed: &[&str]) -> Result<(), ContractError> {
    for coin in funds {
        if !allowed.contains(&coin.denom.as_str()) {
            return Err(ContractError::UnexpectedFundsAttached {
                denom: coin.denom.clone(),
            });
        }
    }
    Ok(())
}

fn prize_transfer_msg(prize_asset: &PrizeAsset, recipient: &Addr, amount: Uint128) -> CosmosMsg {
    match prize_asset {
        PrizeAsset::Native { denom } => BankMsg::Send {
            to_address: recipient.to_string(),
            amount: vec![Coin {
                denom: denom.clone(),
                amount,
            }],
        }
        .into(),
        PrizeAsset::Cw20 { address } => WasmMsg::Execute {
            contract_addr: address.to_string(),
            msg: cosmwasm_std::to_json_binary(&Cw20ExecuteMsg::Transfer {
                recipient: recipient.to_string(),
                amount,
            })
            .expect("Cw20ExecuteMsg::Transfer always serializes"),
            funds: vec![],
        }
        .into(),
    }
}

/// Holds the fixed USDC service fee, refunding any overpayment. Shared by
/// `PayServiceFee` and the native `DepositPrize` convenience path.
fn collect_service_fee(config: &crate::state::Config, sent_usdc: Uint128) -> Result<(Uint128, Uint128), ContractError> {
    let required_usdc = config.fee_amount_usdc;
    if sent_usdc < required_usdc {
        return Err(ContractError::WrongFeePayment {
            expected: required_usdc,
            denom: config.usdc_denom.clone(),
        });
    }
    let refund = sent_usdc - required_usdc;
    Ok((required_usdc, refund))
}

pub fn execute_pay_service_fee(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if raffle.status != RaffleStatus::Funding {
        return Err(ContractError::AlreadyFunded {});
    }
    if raffle.fee_paid {
        return Err(ContractError::AlreadyFunded {});
    }

    reject_unexpected_funds(&info.funds, &[&config.usdc_denom])?;
    let sent_usdc = info
        .funds
        .iter()
        .find(|c| c.denom == config.usdc_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    let (required_usdc, refund) = collect_service_fee(&config, sent_usdc)?;

    raffle.fee_amount = required_usdc;
    raffle.fee_paid = true;
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: config.usdc_denom,
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "pay_service_fee")
        .add_attribute("fee_amount", required_usdc.to_string()))
}

pub fn execute_deposit_prize(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    let native_denom = match &config.prize_asset {
        PrizeAsset::Native { denom } => denom.clone(),
        PrizeAsset::Cw20 { .. } => return Err(ContractError::PrizeIsCw20 {}),
    };

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if raffle.status != RaffleStatus::Funding {
        return Err(ContractError::AlreadyFunded {});
    }

    if raffle.fee_paid {
        reject_unexpected_funds(&info.funds, &[&native_denom])?;
    } else {
        reject_unexpected_funds(&info.funds, &[&native_denom, &config.usdc_denom])?;
    }

    let prize_sent = info
        .funds
        .iter()
        .find(|c| c.denom == native_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if prize_sent.is_zero() {
        return Err(ContractError::ZeroPrize {});
    }

    let mut messages: Vec<CosmosMsg> = vec![];

    if raffle.fee_paid {
        // Fee was already settled via a separate `PayServiceFee` call (this is
        // required, not just allowed, when the prize denom is the same as the
        // USDC fee denom - see `MustPayServiceFeeSeparately` below).
    } else {
        if native_denom == config.usdc_denom {
            return Err(ContractError::MustPayServiceFeeSeparately {});
        }
        let sent_usdc = info
            .funds
            .iter()
            .find(|c| c.denom == config.usdc_denom)
            .map(|c| c.amount)
            .unwrap_or_default();
        let (required_usdc, refund) = collect_service_fee(&config, sent_usdc)?;
        raffle.fee_amount = required_usdc;
        raffle.fee_paid = true;
        if !refund.is_zero() {
            messages.push(
                BankMsg::Send {
                    to_address: info.sender.to_string(),
                    amount: vec![Coin {
                        denom: config.usdc_denom.clone(),
                        amount: refund,
                    }],
                }
                .into(),
            );
        }
    }

    raffle.prize_amount = prize_sent;
    raffle.status = RaffleStatus::Open;
    raffle.opened_at = Some(env.block.time);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "deposit_prize")
        .add_attribute("prize_amount", prize_sent.to_string())
        .add_attribute("fee_amount", raffle.fee_amount.to_string()))
}

pub fn execute_receive(deps: DepsMut, env: Env, info: MessageInfo, wrapper: Cw20ReceiveMsg) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    let cw20_address = match &config.prize_asset {
        PrizeAsset::Cw20 { address } => address.clone(),
        PrizeAsset::Native { .. } => return Err(ContractError::PrizeIsNative {}),
    };
    // The CW20 contract itself is `info.sender` for a `Receive` callback; the
    // wallet that actually triggered the `Send` is `wrapper.sender`.
    if info.sender != cw20_address {
        return Err(ContractError::Unauthorized {});
    }
    let original_sender = deps.api.addr_validate(&wrapper.sender)?;
    if original_sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if raffle.status != RaffleStatus::Funding {
        return Err(ContractError::AlreadyFunded {});
    }
    if !raffle.fee_paid {
        return Err(ContractError::MustPayServiceFeeSeparately {});
    }
    if wrapper.amount.is_zero() {
        return Err(ContractError::ZeroPrize {});
    }

    match from_json::<Cw20HookMsg>(&wrapper.msg)? {
        Cw20HookMsg::DepositPrize {} => {
            raffle.prize_amount = wrapper.amount;
            raffle.status = RaffleStatus::Open;
            raffle.opened_at = Some(env.block.time);
            RAFFLE.save(deps.storage, &raffle)?;

            Ok(Response::new()
                .add_attribute("action", "deposit_prize")
                .add_attribute("prize_amount", wrapper.amount.to_string())
                .add_attribute("fee_amount", raffle.fee_amount.to_string()))
        }
    }
}

/// Bounds how many tickets a single wallet may hold. For SingleWinner/Podium
/// *paid* raffles, no more than half of `max_players` worth - bounds the
/// worst-case size of `entrants` (so `DrawWinner`'s winner-picking hash can
/// never grow unbounded) while still leaving room for the weighted-odds "buy
/// more, better chances" feature - buying more tickets costs real money, so
/// it's an ordinary lottery trade-off.
///
/// Free raffles (`ticket_price` zero) are capped at exactly 1 per wallet
/// regardless of type (2026-07-21): with nothing to lose by calling
/// `BuyTicket` again, a single wallet could otherwise grab up to half of
/// `max_players`' worth of entries for free, dominating a raffle meant to
/// give the community an even chance. Airdrop is always 1 per wallet anyway
/// (CodeRabbit review, 2026-07-15: at the top fee tier, the SingleWinner/
/// Podium formula would allow up to 500 tickets/wallet, so `entrants` could
/// reach 500,000 - and `CancelRaffle` scans `unique_players x entrants`
/// refunding everyone in a single transaction, which could exceed block gas
/// and strand the raffle `Closed` forever; Airdrop splits equally per unique
/// player anyway, so extra tickets per wallet buy nothing).
pub fn max_tickets_per_wallet(raffle_type: RaffleType, max_players: u32, ticket_price: Uint128) -> u32 {
    if ticket_price.is_zero() {
        return 1;
    }
    match raffle_type {
        RaffleType::Airdrop => 1,
        RaffleType::SingleWinner | RaffleType::Podium => std::cmp::max(1, max_players / 2),
    }
}

pub fn execute_buy_ticket(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }
    if let Some(allowlist) = &config.allowed_entrants {
        if !allowlist.contains(&info.sender) {
            return Err(ContractError::NotAllowed {});
        }
    }

    let cap = max_tickets_per_wallet(config.raffle_type, config.max_players, config.ticket_price);
    let already_bought = raffle.entrants.iter().filter(|e| **e == info.sender).count() as u32;
    if already_bought >= cap {
        return Err(ContractError::TicketCapExceeded { max_per_wallet: cap });
    }

    // Unlike DepositPrize/PayServiceFee, this used to accept any attached
    // funds silently: only `ticket_denom` was ever inspected, so a second,
    // unrelated coin riding along on the same call (a cloned/phishing
    // frontend, a raw contract call, or a stale-price frontend bug) would be
    // absorbed with no refund and no record - the "free raffle carries no
    // financial risk" reasoning behind skipping the prize allowlist above
    // depends on BuyTicket genuinely costing nothing when ticket_price is 0.
    if config.ticket_price.is_zero() {
        reject_unexpected_funds(&info.funds, &[])?;
    } else {
        reject_unexpected_funds(&info.funds, &[&config.ticket_denom])?;
    }

    if !config.ticket_price.is_zero() {
        let sent_amount = info
            .funds
            .iter()
            .find(|c| c.denom == config.ticket_denom)
            .map(|c| c.amount)
            .unwrap_or_default();
        if sent_amount != config.ticket_price {
            return Err(ContractError::WrongTicketPayment {
                expected: config.ticket_price,
                denom: config.ticket_denom.clone(),
            });
        }
        raffle.ticket_revenue += sent_amount;
    }

    raffle.entrants.push(info.sender.clone());
    if !raffle.unique_players.contains(&info.sender) {
        raffle.unique_players.push(info.sender.clone());
    }

    let auto_closed = raffle.unique_players.len() as u32 >= config.max_players;
    let mut messages: Vec<CosmosMsg> = vec![];
    if auto_closed {
        raffle.status = RaffleStatus::Closed;
        raffle.closed_at = Some(env.block.time);
        // Sold out - draw right here, in the same atomic transaction as the
        // ticket purchase that completed the cap, instead of leaving a
        // separate DrawWinner call pending. Removes the free-rearm grinding
        // hole (see MAX_REARMS_BEFORE_PERMISSIONLESS) for this path - no
        // window to wait for, no separate call, no free re-rolls. Doesn't
        // remove every residual timing angle: whichever wallet ends up
        // buying the closing ticket still weakly picks the block that seeds
        // the hash by choosing when to submit - same single-shot,
        // can't-predict-a-future-block's-exact-nanosecond-timestamp caveat
        // already accepted platform-wide (see rand.rs), not the
        // repeatable-for-free grinding this fix targets. Always safe to draw
        // immediately here - max_players >= min_players is enforced at
        // instantiate, so reaching max_players already implies min_players
        // is met.
        messages = perform_draw(&config, &mut raffle, env.block.height, env.block.time);
    }

    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "buy_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("auto_closed", auto_closed.to_string()))
}

/// Self-service refund for a wallet's own tickets, callable only while
/// `min_players` hasn't been reached yet - deliberately no minimum wait time
/// before a second player shows up, since the player can simply leave
/// whenever they lose interest instead of being locked in. Once `min_players`
/// is reached this stops working, the same way `CloseRound`/`DrawWinner`
/// treat that as the point the raffle is genuinely "in play" for everyone in
/// it. Mirrors Wheel Manager's `WithdrawTicket` exactly.
pub fn execute_withdraw_ticket(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }
    if raffle.unique_players.len() as u32 >= config.min_players {
        return Err(ContractError::RaffleAlreadyLocked {});
    }

    let ticket_count = raffle.entrants.iter().filter(|e| **e == info.sender).count();
    if ticket_count == 0 {
        return Err(ContractError::NoTicketsToWithdraw {});
    }

    let refund = config.ticket_price * Uint128::from(ticket_count as u128);
    raffle.entrants.retain(|e| *e != info.sender);
    raffle.unique_players.retain(|e| *e != info.sender);
    if !refund.is_zero() {
        raffle.ticket_revenue = raffle.ticket_revenue.checked_sub(refund).unwrap_or_default();
    }
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom,
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "withdraw_ticket")
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Permissionless for anyone once the raffle's own conditions are met
/// (reaches max_players, or the timeout elapses with at least min_players) -
/// same as every other close/draw action platform-wide. The creator gets one
/// extra path on top: they can close early, on their own judgment, without
/// waiting for either condition - they're the one paying for and running
/// this raffle, and are best placed to decide "enough people showed up".
/// Still can't go below min_players even as the creator: DrawWinner enforces
/// that floor separately regardless of how the raffle got closed, so an
/// early close under it would just strand the raffle Closed-but-undrawable.
pub fn execute_close_round(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    // No action here ever expects funds - anything attached would otherwise
    // be silently absorbed with no refund and no record, same class of bug
    // just closed on BuyTicket.
    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }

    let reached_max = raffle.unique_players.len() as u32 >= config.max_players;
    let has_min = raffle.unique_players.len() as u32 >= config.min_players;
    let opened_at = raffle.opened_at.unwrap_or(env.block.time);
    let timeout_elapsed = env.block.time.seconds() >= opened_at.seconds() + config.round_timeout_seconds;
    let creator_early_close = info.sender == config.creator && has_min;

    if !(reached_max || (timeout_elapsed && has_min) || creator_early_close) {
        return Err(ContractError::CannotCloseRound {});
    }

    raffle.status = RaffleStatus::Closed;
    raffle.closed_at = Some(env.block.time);
    raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_attribute("action", "close_round"))
}

/// Creator-exclusive at first, unlike CloseRound - the creator paid the
/// service fee and put up the prize, and drawing is the moment the winner
/// gets announced, so they get to be the one who cuts the ribbon and tells
/// their own community first, instead of finding out secondhand that
/// someone else already ran it. A deliberate correction (2026-07-21) from
/// the platform's usual fully-permissionless close/draw pattern - CloseRound
/// stays permissionless for non-creators, only DrawWinner is restricted.
///
/// That exclusivity isn't forever, though: once `unclaimed_deadline_days`
/// has passed since the raffle *closed* (same field/duration already used
/// for sweeping unclaimed Airdrop shares, reused here for a second,
/// separate deadline - not the same clock), anyone can draw it. A raffle
/// reaches `Closed` on its own (auto-close on the last ticket, or anyone's
/// permissionless CloseRound at timeout) - if the creator's wallet is then
/// lost or unresponsive, a `Closed` raffle with no fallback would strand
/// its prize/ticket revenue/fee forever, since CancelRaffle is blocked once
/// Closed. Found by an Opus+Fable review (2026-07-21) of the first,
/// fallback-less version of this creator-only restriction.
pub fn execute_draw_winner(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Closed {
        return Err(ContractError::RaffleNotClosed {});
    }
    if info.sender != config.creator {
        // `closed_at` is always set atomically with status becoming Closed
        // (both the auto-close in execute_buy_ticket and the close below
        // do this), so this is never actually reached - but propagating an
        // error here instead of defaulting to `env.block.time` matters: a
        // silent "now" default would make the fallback deadline recede
        // into the future on every call, permanently defeating the one
        // thing this fallback exists to guarantee. Same defensive pattern
        // ReclaimUnclaimed already uses for its own timestamp field.
        let closed_at = raffle.closed_at.ok_or(ContractError::RaffleNotClosed {})?;
        let fallback_deadline = closed_at.seconds() + config.unclaimed_deadline_days * 86400;
        // Grinding-resistance fallback (2026-07-22): a creator can rearm the
        // window for free, indefinitely, up to `unclaimed_deadline_days` -
        // see `MAX_REARMS_BEFORE_PERMISSIONLESS`'s doc comment for why that's
        // a real risk, not just theoretical. Once the raffle has rearmed
        // that many times without drawing, anyone can draw immediately
        // instead of waiting out the full deadline.
        let rearm_limit_reached = raffle.rearm_count >= MAX_REARMS_BEFORE_PERMISSIONLESS;
        if env.block.time.seconds() < fallback_deadline && !rearm_limit_reached {
            return Err(ContractError::Unauthorized {});
        }
    }
    let required_height = raffle.draw_after_height.unwrap_or(u64::MAX);
    if env.block.height < required_height {
        return Err(ContractError::DrawTooEarly { required_height });
    }
    // Ceiling on the draw window - see wheel-manager's execute_draw_winner
    // for the full rationale. Not an error, just a rearm to a fresh window -
    // *unless* the rearm cap is already spent (2026-07-22 Opus+Fable review):
    // rearming unconditionally here would let the creator keep re-rolling
    // forever whenever no one else bothers to call DrawWinner in the
    // meantime, silently defeating MAX_REARMS_BEFORE_PERMISSIONLESS (that
    // constant only granted *permission* for someone else to draw - it never
    // actually stopped the creator from rearming). Once the cap is spent,
    // there's no more free re-roll for anyone: this call just draws right
    // here, at whatever height it landed on, instead of resetting the window
    // again.
    if env.block.height >= required_height + config.draw_window_blocks
        && raffle.rearm_count < MAX_REARMS_BEFORE_PERMISSIONLESS
    {
        raffle.rearm_count += 1;
        raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
        RAFFLE.save(deps.storage, &raffle)?;
        return Ok(Response::new()
            .add_attribute("action", "rearm_draw_window")
            .add_attribute("new_draw_after_height", raffle.draw_after_height.unwrap().to_string())
            .add_attribute("rearm_count", raffle.rearm_count.to_string()));
    }
    if (raffle.unique_players.len() as u32) < config.min_players {
        return Err(ContractError::NotEnoughPlayers {
            min_players: config.min_players,
        });
    }

    let messages = perform_draw(&config, &mut raffle, env.block.height, env.block.time);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "draw_winner")
        .add_attribute("winners", raffle.winners.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(",")))
}

pub fn execute_claim_airdrop_share(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let raffle = RAFFLE.load(deps.storage)?;

    // A participant claiming their share is exactly the scenario a phishing
    // frontend could dress up as "pay a small fee to claim" - guard it the
    // same way BuyTicket now is, so a free (or paid) Airdrop's "nobody can
    // lose real money here" guarantee actually holds for this call too.
    reject_unexpected_funds(&info.funds, &[])?;

    if config.raffle_type != RaffleType::Airdrop {
        return Err(ContractError::NotAirdrop {});
    }
    if raffle.status != RaffleStatus::Drawn {
        return Err(ContractError::RaffleNotDrawn {});
    }
    if raffle.reclaimed {
        return Err(ContractError::AlreadyReclaimed {});
    }
    if !raffle.unique_players.contains(&info.sender) {
        return Err(ContractError::NotAParticipant {});
    }
    if AIRDROP_CLAIMS.may_load(deps.storage, info.sender.clone())?.unwrap_or(false) {
        return Err(ContractError::AlreadyClaimed {});
    }

    AIRDROP_CLAIMS.save(deps.storage, info.sender.clone(), &true)?;

    Ok(Response::new()
        .add_message(prize_transfer_msg(&config.prize_asset, &info.sender, raffle.airdrop_share))
        .add_attribute("action", "claim_airdrop_share")
        .add_attribute("claimer", info.sender)
        .add_attribute("share", raffle.airdrop_share.to_string()))
}

pub fn execute_reclaim_unclaimed(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if config.raffle_type != RaffleType::Airdrop {
        return Err(ContractError::NotAirdrop {});
    }
    if raffle.status != RaffleStatus::Drawn {
        return Err(ContractError::RaffleNotDrawn {});
    }
    if raffle.reclaimed {
        return Err(ContractError::AlreadyReclaimed {});
    }
    let drawn_at = raffle.drawn_at.ok_or(ContractError::RaffleNotDrawn {})?;
    let deadline = drawn_at.seconds() + config.unclaimed_deadline_days * 86400;
    if env.block.time.seconds() < deadline {
        return Err(ContractError::UnclaimedDeadlineNotReached {});
    }

    let mut unclaimed_count: u128 = 0;
    for player in &raffle.unique_players {
        let claimed = AIRDROP_CLAIMS.may_load(deps.storage, player.clone())?.unwrap_or(false);
        if !claimed {
            unclaimed_count += 1;
        }
    }
    let unclaimed_total = raffle.airdrop_share * Uint128::from(unclaimed_count);
    raffle.reclaimed = true;
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !unclaimed_total.is_zero() {
        messages.push(prize_transfer_msg(&config.prize_asset, &config.creator, unclaimed_total));
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "reclaim_unclaimed")
        .add_attribute("amount", unclaimed_total.to_string()))
}

/// Shared by `CancelRaffle` (creator-initiated) and `ExpireRaffle`
/// (permissionless safety net) - both terminate a raffle the same way:
/// prize + fee back to the creator, ticket price back to each buyer.
fn full_refund_messages(config: &crate::state::Config, raffle: &crate::state::RaffleState) -> Vec<CosmosMsg> {
    let mut messages: Vec<CosmosMsg> = vec![];
    if !raffle.prize_amount.is_zero() {
        messages.push(prize_transfer_msg(&config.prize_asset, &config.creator, raffle.prize_amount));
    }
    if !raffle.fee_amount.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.creator.to_string(),
                amount: vec![Coin {
                    denom: config.usdc_denom.clone(),
                    amount: raffle.fee_amount,
                }],
            }
            .into(),
        );
    }
    if !config.ticket_price.is_zero() {
        for player in &raffle.unique_players {
            let ticket_count = raffle.entrants.iter().filter(|e| *e == player).count() as u128;
            let refund_amount = config.ticket_price * Uint128::from(ticket_count);
            if !refund_amount.is_zero() {
                messages.push(
                    BankMsg::Send {
                        to_address: player.to_string(),
                        amount: vec![Coin {
                            denom: config.ticket_denom.clone(),
                            amount: refund_amount,
                        }],
                    }
                    .into(),
                );
            }
        }
    }
    messages
}

pub fn execute_cancel_raffle(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    // Same guard as the other funds-less actions above - not one of the 4
    // originally flagged, but the identical gap (not asked for, but included
    // for the same reason: it's the same one-line fix closing the same bug
    // class, not a separate decision).
    reject_unexpected_funds(&info.funds, &[])?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    match raffle.status {
        RaffleStatus::Funding | RaffleStatus::Open => {}
        RaffleStatus::Cancelled => return Err(ContractError::AlreadyCancelled {}),
        RaffleStatus::Closed | RaffleStatus::Drawn => return Err(ContractError::CannotCancel {}),
    }

    let messages = full_refund_messages(&config, &raffle);
    raffle.status = RaffleStatus::Cancelled;
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_messages(messages).add_attribute("action", "cancel_raffle"))
}

/// Permissionless safety net for a raffle nobody bothered finishing: if
/// `min_players` was never reached within `max_raffle_age_seconds` of
/// opening, anyone can force the same full refund `CancelRaffle` does,
/// without needing the creator to act. Without this, a raffle stuck below
/// `min_players` with an unresponsive creator (lost wallet, lost interest)
/// would strand every ticket buyer's money forever, since `CancelRaffle` is
/// creator-only. Mirrors Wheel Manager's `ExpireRound`, adapted for CYOL's
/// one-shot-raffle shape (terminates to `Cancelled` and refunds immediately
/// in one push, rather than opening a next round and requiring a separate
/// pull-based reclaim per wallet).
pub fn execute_expire_raffle(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }
    let has_min = raffle.unique_players.len() as u32 >= config.min_players;
    let opened_at = raffle.opened_at.unwrap_or(env.block.time);
    let age_reached = env.block.time.seconds() >= opened_at.seconds() + config.max_raffle_age_seconds;
    if has_min || !age_reached {
        return Err(ContractError::CannotExpireRaffle {});
    }

    let messages = full_refund_messages(&config, &raffle);
    raffle.status = RaffleStatus::Cancelled;
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_messages(messages).add_attribute("action", "expire_raffle"))
}
