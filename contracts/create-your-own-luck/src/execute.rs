use cosmwasm_std::{
    from_json, Addr, BankMsg, Coin, CosmosMsg, DepsMut, Env, MessageInfo, Response, Uint128,
    WasmMsg,
};
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};

use crate::error::ContractError;
use crate::msg::Cw20HookMsg;
use crate::price_oracle::quote_ustc_fee;
use crate::rand::pick_winner_index;
use crate::state::{PrizeAsset, RaffleStatus, RaffleType, AIRDROP_CLAIMS, CONFIG, RAFFLE};

const FEE_SPLIT_BPS: u128 = 3333; // ~1/3 each, dust to treasury (see draw_winner)
const FEE_SPLIT_DENOM: u128 = 10000;
const PODIUM_BPS: [u128; 3] = [5000, 3000, 2000]; // 50/30/20, dust to 1st place
const PODIUM_DENOM: u128 = 10000;

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

/// Quotes and holds the USTC service fee, refunding any overpayment. Shared by
/// `PayServiceFee` and the native `DepositPrize` convenience path.
fn collect_service_fee(deps: &DepsMut, config: &crate::state::Config, sent_ustc: Uint128) -> Result<(Uint128, Uint128), ContractError> {
    let required_ustc = quote_ustc_fee(&deps.querier, config)?;
    if sent_ustc < required_ustc {
        return Err(ContractError::WrongFeePayment {
            expected: required_ustc,
            denom: config.ustc_denom.clone(),
        });
    }
    let refund = sent_ustc - required_ustc;
    Ok((required_ustc, refund))
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

    let sent_ustc = info
        .funds
        .iter()
        .find(|c| c.denom == config.ustc_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    let (required_ustc, refund) = collect_service_fee(&deps, &config, sent_ustc)?;

    raffle.fee_amount = required_ustc;
    raffle.fee_paid = true;
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: config.ustc_denom,
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "pay_service_fee")
        .add_attribute("fee_amount", required_ustc.to_string()))
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
        // USTC fee denom - see `MustPayServiceFeeSeparately` below).
    } else {
        if native_denom == config.ustc_denom {
            return Err(ContractError::MustPayServiceFeeSeparately {});
        }
        let sent_ustc = info
            .funds
            .iter()
            .find(|c| c.denom == config.ustc_denom)
            .map(|c| c.amount)
            .unwrap_or_default();
        let (required_ustc, refund) = collect_service_fee(&deps, &config, sent_ustc)?;
        raffle.fee_amount = required_ustc;
        raffle.fee_paid = true;
        if !refund.is_zero() {
            messages.push(
                BankMsg::Send {
                    to_address: info.sender.to_string(),
                    amount: vec![Coin {
                        denom: config.ustc_denom.clone(),
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

/// No single wallet may hold more than half of a raffle's `max_players` worth
/// of tickets - bounds the worst-case size of `entrants` (so `DrawWinner`'s
/// winner-picking hash can never grow unbounded) while still leaving room for
/// the weighted-odds "buy more, better chances" feature. Applies even to free
/// (ticket_price = 0) raffles, since the concern is entrants-list size, not
/// payment. Not a separate config field on purpose - always derived from
/// `max_players`.
pub fn max_tickets_per_wallet(max_players: u32) -> u32 {
    std::cmp::max(1, max_players / 2)
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

    let cap = max_tickets_per_wallet(config.max_players);
    let already_bought = raffle.entrants.iter().filter(|e| **e == info.sender).count() as u32;
    if already_bought >= cap {
        return Err(ContractError::TicketCapExceeded { max_per_wallet: cap });
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
    if auto_closed {
        raffle.status = RaffleStatus::Closed;
        raffle.closed_at = Some(env.block.time);
        raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    }

    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_attribute("action", "buy_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("auto_closed", auto_closed.to_string()))
}

pub fn execute_close_round(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }

    let reached_max = raffle.unique_players.len() as u32 >= config.max_players;
    let has_min = raffle.unique_players.len() as u32 >= config.min_players;
    let opened_at = raffle.opened_at.unwrap_or(env.block.time);
    let timeout_elapsed = env.block.time.seconds() >= opened_at.seconds() + config.round_timeout_seconds;

    if !(reached_max || (timeout_elapsed && has_min)) {
        return Err(ContractError::CannotCloseRound {});
    }

    raffle.status = RaffleStatus::Closed;
    raffle.closed_at = Some(env.block.time);
    raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_attribute("action", "close_round"))
}

pub fn execute_draw_winner(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if raffle.status != RaffleStatus::Closed {
        return Err(ContractError::RaffleNotClosed {});
    }
    let required_height = raffle.draw_after_height.unwrap_or(u64::MAX);
    if env.block.height < required_height {
        return Err(ContractError::DrawTooEarly { required_height });
    }
    // Ceiling on the draw window - see wheel-manager's execute_draw_winner
    // for the full rationale. Not an error, just a rearm to a fresh window.
    if env.block.height >= required_height + config.draw_window_blocks {
        raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
        RAFFLE.save(deps.storage, &raffle)?;
        return Ok(Response::new()
            .add_attribute("action", "rearm_draw_window")
            .add_attribute("new_draw_after_height", raffle.draw_after_height.unwrap().to_string()));
    }
    if (raffle.unique_players.len() as u32) < config.min_players {
        return Err(ContractError::NotEnoughPlayers {
            min_players: config.min_players,
        });
    }

    let mut messages: Vec<CosmosMsg> = vec![];

    match config.raffle_type {
        RaffleType::SingleWinner => {
            let idx = pick_winner_index(0, env.block.height, env.block.time.nanos(), 0, &raffle.entrants);
            let winner = raffle.entrants[idx].clone();
            raffle.winners = vec![winner.clone()];
            raffle.prize_shares = vec![raffle.prize_amount];
            messages.push(prize_transfer_msg(&config.prize_asset, &winner, raffle.prize_amount));
        }
        RaffleType::Podium => {
            let mut winners: Vec<Addr> = vec![];
            let mut pool = raffle.entrants.clone();
            for place in 0..3u64 {
                let idx = pick_winner_index(0, env.block.height, env.block.time.nanos(), place, &pool);
                let winner = pool[idx].clone();
                winners.push(winner.clone());
                pool.retain(|e| *e != winner);
            }

            let allocated: Uint128 = PODIUM_BPS
                .iter()
                .map(|bps| raffle.prize_amount.multiply_ratio(*bps, PODIUM_DENOM))
                .sum();
            let mut shares: Vec<Uint128> = PODIUM_BPS
                .iter()
                .map(|bps| raffle.prize_amount.multiply_ratio(*bps, PODIUM_DENOM))
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
        let burn_cut = raffle.fee_amount.multiply_ratio(FEE_SPLIT_BPS, FEE_SPLIT_DENOM);
        let mut treasury_cut = raffle.fee_amount.multiply_ratio(FEE_SPLIT_BPS, FEE_SPLIT_DENOM);
        let allocated = founder_cut + burn_cut + treasury_cut;
        treasury_cut += raffle.fee_amount.checked_sub(allocated).unwrap_or_default();

        for (addr, amount) in [
            (&config.founder_fee_address, founder_cut),
            (&config.treasury_address, treasury_cut),
            (&config.burn_address, burn_cut),
        ] {
            if !amount.is_zero() {
                messages.push(
                    BankMsg::Send {
                        to_address: addr.to_string(),
                        amount: vec![Coin {
                            denom: config.ustc_denom.clone(),
                            amount,
                        }],
                    }
                    .into(),
                );
            }
        }
    }

    raffle.status = RaffleStatus::Drawn;
    raffle.drawn_at = Some(env.block.time);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "draw_winner")
        .add_attribute("winners", raffle.winners.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(",")))
}

pub fn execute_claim_airdrop_share(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let raffle = RAFFLE.load(deps.storage)?;

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

pub fn execute_cancel_raffle(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    match raffle.status {
        RaffleStatus::Funding | RaffleStatus::Open => {}
        RaffleStatus::Cancelled => return Err(ContractError::AlreadyCancelled {}),
        RaffleStatus::Closed | RaffleStatus::Drawn => return Err(ContractError::CannotCancel {}),
    }

    let mut messages: Vec<CosmosMsg> = vec![];
    if !raffle.prize_amount.is_zero() {
        messages.push(prize_transfer_msg(&config.prize_asset, &config.creator, raffle.prize_amount));
    }
    if !raffle.fee_amount.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.creator.to_string(),
                amount: vec![Coin {
                    denom: config.ustc_denom.clone(),
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

    raffle.status = RaffleStatus::Cancelled;
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_messages(messages).add_attribute("action", "cancel_raffle"))
}
