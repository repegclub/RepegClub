use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Coin, CosmosMsg, DepsMut, Env, MessageInfo, Reply, Response,
    StdResult, Storage, SubMsg, SubMsgResult, Uint128, WasmMsg,
};

use crate::error::ContractError;
use crate::rand::pick_winner_index;
use crate::state::{
    Config, GlobalState, Round, RoundStatus, CONFIG, PENDING_WEEKLY_CONTRIBUTION, ROUNDS, STATE,
    TOTAL_INVESTED, TOTAL_REDEEMED, WINNER_INDEX,
};

const PRIZE_BPS: u128 = 6000; // 60%
const NEXT_ROUND_BPS: u128 = 500; // 5%
const WEEKLY_BPS: u128 = 2000; // 20%
const TREASURY_BPS: u128 = 1200; // 12%
const ADMIN_BPS: u128 = 300; // 3%
const BPS_DENOM: u128 = 10000;

/// Caps how many times `DrawWinner` can rearm the draw window for free (see
/// the "past the window" branch in `execute_draw_winner`) before the next
/// eligible call just draws right here instead of rearming again. Without
/// this, `DrawWinner` being permissionless from day one means anyone
/// patient enough to simulate the outcome off-chain for each candidate
/// block can wait for a favorable one indefinitely, free of charge - worse
/// here than in create-your-own-luck (where this same cap originated,
/// 2026-07-22) because there the rearm loop is at least bounded by that
/// raffle's own unclaimed-deadline fallback; here `DrawWinner` has no such
/// creator-vs-anyone distinction to fall back on, so an unbounded rearm
/// really is an unbounded grinding window. 2 matches the value already
/// proven out there.
const MAX_REARMS: u32 = 2;

/// Reply id for the `ContributeToPool` `SubMsg` dispatched to Weekly Round in
/// `perform_draw` (2026-08-25 audit fix, own finding: `execute_draw_winner`'s
/// state changes - `ROUNDS.save` with `status=Drawn`, `winner`,
/// `prize_remaining`, etc. - were already committed before this message was
/// built, but it was previously dispatched as a plain, all-or-nothing
/// `CosmosMsg`. Per CosmWasm/wasmd, any message in a `Response` failing to
/// dispatch reverts the *entire* transaction, so a future failure inside
/// Weekly Round's own `ContributeToPool` (a bug, a bad migration, a new
/// guard added there later) would revert the *whole* wheel-manager draw -
/// winner payout, treasury cut and admin cut included, none of which have
/// anything to do with Weekly Round. Wrapped as `SubMsg::reply_on_error`
/// instead: the draw's other payouts go through regardless, and a failed
/// contribution gets redirected to the treasury from the reply handler
/// instead of being silently swallowed with no destination (see
/// `PENDING_WEEKLY_CONTRIBUTION`'s doc comment for why storage, not the
/// reply's own payload, carries the amount across).
const WEEKLY_CONTRIBUTION_REPLY_ID: u64 = 1;

/// Mirrors Weekly Round's `ExecuteMsg::ContributeToPool` just enough to build the
/// outbound message. Deliberately not a shared crate dependency between the two
/// contracts, so each stays independently upgradable (see project decision on
/// per-contract modularity).
#[cw_serde]
enum WeeklyRoundExecuteMsg {
    ContributeToPool {
        source_wheel: String,
        source_round_id: u64,
    },
}

pub fn open_new_round(
    storage: &mut dyn Storage,
    env: &Env,
    round_id: u64,
    carry_in: Uint128,
) -> StdResult<()> {
    let round = Round {
        round_id,
        status: RoundStatus::Open,
        entrants: vec![],
        unique_players: vec![],
        pool: carry_in,
        opened_at: env.block.time,
        deadline: None,
        closed_at: None,
        draw_after_height: None,
        rearm_count: 0,
        drawn_at: None,
        draw_height: None,
        winner: None,
        prize_remaining: Uint128::zero(),
        expired_at: None,
    };
    ROUNDS.save(storage, round_id, &round)
}

/// No single wallet may hold more than half of a round's `max_players` worth
/// of tickets - bounds the worst-case size of `entrants` (so `DrawWinner`'s
/// winner-picking hash can never grow unbounded and become ungasable) while
/// still leaving room for the weighted-wheel "buy more, better odds" feature.
/// Not a separate config field on purpose - always derived from `max_players`
/// so there's nothing extra to misconfigure.
pub fn max_tickets_per_wallet(max_players: u32) -> u32 {
    std::cmp::max(1, max_players / 2)
}

pub fn execute_buy_ticket(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }

    // Once the round is stale (never reached min_players within
    // max_round_age_seconds), stop accepting tickets - it must go through
    // ExpireRound + ReclaimTicket instead, not keep growing indefinitely.
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    let stale = !has_min
        && env.block.time.seconds() >= round.opened_at.seconds() + config.max_round_age_seconds;
    if stale {
        return Err(ContractError::RoundExpired {});
    }

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

    let cap = max_tickets_per_wallet(config.max_players);
    let already_bought = round.entrants.iter().filter(|e| **e == info.sender).count() as u32;
    if already_bought >= cap {
        return Err(ContractError::TicketCapExceeded { max_per_wallet: cap });
    }

    round.entrants.push(info.sender.clone());
    round.pool += sent_amount;
    if !round.unique_players.contains(&info.sender) {
        round.unique_players.push(info.sender.clone());
    }

    // Rolling "soft close" deadline: once min_players is reached, every
    // further ticket purchase (from anyone, new player or not) pushes the
    // close deadline forward by another round_timeout_seconds - the round
    // only actually becomes closeable once nobody buys for a full window.
    if round.unique_players.len() as u32 >= config.min_players {
        round.deadline = Some(env.block.time.plus_seconds(config.round_timeout_seconds));
    }

    let auto_closed = round.unique_players.len() as u32 >= config.max_players;
    let mut messages: Vec<CosmosMsg> = vec![];
    let mut weekly_submsg: Option<SubMsg> = None;
    if auto_closed {
        round.status = RoundStatus::Closed;
        round.closed_at = Some(env.block.time);
        // Sold out - draw right here, in the same atomic transaction as the
        // ticket purchase that completed the cap, instead of leaving a
        // separate DrawWinner call (and its draw_delay_blocks/draw_window_blocks
        // window) pending. Removes the free-rearm grinding hole (MAX_REARMS)
        // for this path entirely - no window to wait for, no separate call,
        // no free re-rolls. Doesn't remove every residual timing angle:
        // whichever wallet ends up buying the closing ticket still weakly
        // picks the block that seeds the hash by choosing when to submit -
        // same single-shot, can't-predict-a-future-block's-exact-nanosecond-
        // timestamp caveat already accepted platform-wide (see rand.rs), not
        // the repeatable-for-free grinding this fix targets. Always safe to
        // draw immediately here - max_players >= min_players is enforced at
        // instantiate, so reaching max_players already implies min_players
        // is met.
        (messages, weekly_submsg) = perform_draw(deps.storage, &env, &config, &mut state, &mut round)?;
        STATE.save(deps.storage, &state)?;
    }

    ROUNDS.save(deps.storage, round.round_id, &round)?;
    add_invested(deps.storage, &info.sender, sent_amount)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_submessages(weekly_submsg)
        .add_attribute("action", "buy_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("round_id", round.round_id.to_string())
        .add_attribute("pool", round.pool.to_string())
        .add_attribute("auto_closed", auto_closed.to_string()))
}

pub fn execute_close_round(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }

    let reached_max = round.unique_players.len() as u32 >= config.max_players;
    // `deadline` is only ever set once min_players is reached (see
    // execute_buy_ticket), so checking it alone already implies has_min.
    let deadline_passed = round.deadline.is_some_and(|d| env.block.time >= d);
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    // Hard ceiling on how long the rolling deadline can keep getting pushed
    // forward by new tickets - forces a close regardless, once min_players
    // was reached. If min_players was *never* reached, this same age
    // threshold is handled by ExpireRound instead, not here.
    let hard_cap_passed =
        env.block.time.seconds() >= round.opened_at.seconds() + config.max_round_age_seconds;

    if !(reached_max || deadline_passed || (has_min && hard_cap_passed)) {
        return Err(ContractError::CannotCloseRound {});
    }

    round.status = RoundStatus::Closed;
    round.closed_at = Some(env.block.time);
    round.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    ROUNDS.save(deps.storage, round.round_id, &round)?;

    Ok(Response::new()
        .add_attribute("action", "close_round")
        .add_attribute("round_id", round.round_id.to_string()))
}

/// Permissionless. Only fires when `min_players` was never reached and
/// `max_round_age_seconds` has elapsed - the counterpart to `CloseRound` for
/// a round that never got enough interest. Opens the next round immediately
/// so the game isn't stuck waiting on this one to be resolved.
pub fn execute_expire_round(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    let age_reached =
        env.block.time.seconds() >= round.opened_at.seconds() + config.max_round_age_seconds;
    if has_min || !age_reached {
        return Err(ContractError::CannotExpireRound {});
    }

    // Only the ticket money is owed to specific buyers (reclaimable below);
    // anything else in the pool is the previous round's 5% carry-in, which
    // isn't anyone's individual money and rolls forward to the next round
    // instead of sitting stranded here.
    let tickets_value = config.ticket_price * Uint128::from(round.entrants.len() as u128);
    let carry_forward = round.pool.checked_sub(tickets_value).unwrap_or_default();
    round.pool = tickets_value;
    round.status = RoundStatus::Expired;
    round.expired_at = Some(env.block.time);
    let finished_round_id = round.round_id;
    ROUNDS.save(deps.storage, round.round_id, &round)?;

    state.current_round_id += 1;
    let new_round_id = state.current_round_id;
    STATE.save(deps.storage, &state)?;
    open_new_round(deps.storage, &env, new_round_id, carry_forward)?;

    Ok(Response::new()
        .add_attribute("action", "expire_round")
        .add_attribute("round_id", finished_round_id.to_string())
        .add_attribute("reclaimable_pool", tickets_value.to_string())
        .add_attribute("carried_forward", carry_forward.to_string()))
}

/// Callable by any wallet that bought at least one ticket in an `Expired`
/// round - refunds exactly what that wallet paid and removes its entries
/// from the round, so it can't be reclaimed twice.
pub fn execute_reclaim_ticket(
    deps: DepsMut,
    info: MessageInfo,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    if round.status != RoundStatus::Expired {
        return Err(ContractError::RoundNotExpired { round_id });
    }

    let ticket_count = round.entrants.iter().filter(|e| **e == info.sender).count();
    if ticket_count == 0 {
        return Err(ContractError::NotAnEntrant { round_id });
    }

    let refund = config.ticket_price * Uint128::from(ticket_count as u128);
    round.entrants.retain(|e| *e != info.sender);
    round.unique_players.retain(|e| *e != info.sender);
    round.pool = round.pool.checked_sub(refund).unwrap_or_default();
    ROUNDS.save(deps.storage, round_id, &round)?;
    subtract_invested(deps.storage, &info.sender, refund)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom,
                amount: refund,
            }],
        })
        .add_attribute("action", "reclaim_ticket")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Self-service refund for a wallet's own tickets in the current round,
/// callable only while `min_players` hasn't been reached yet - deliberately
/// no minimum wait time before a second player shows up, since the player
/// can simply leave whenever they lose interest instead of being locked in.
/// Once `min_players` is reached the rolling deadline takes over and this
/// stops working, the same way `CloseRound`/`DrawWinner` treat that as the
/// point the round is genuinely "in play" for everyone in it.
pub fn execute_withdraw_ticket(
    deps: DepsMut,
    info: MessageInfo,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }
    if round.unique_players.len() as u32 >= config.min_players {
        return Err(ContractError::RoundAlreadyLocked { round_id });
    }

    let ticket_count = round.entrants.iter().filter(|e| **e == info.sender).count();
    if ticket_count == 0 {
        return Err(ContractError::NotAnEntrant { round_id });
    }

    let refund = config.ticket_price * Uint128::from(ticket_count as u128);
    round.entrants.retain(|e| *e != info.sender);
    round.unique_players.retain(|e| *e != info.sender);
    round.pool = round.pool.checked_sub(refund).unwrap_or_default();
    ROUNDS.save(deps.storage, round_id, &round)?;
    subtract_invested(deps.storage, &info.sender, refund)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom,
                amount: refund,
            }],
        })
        .add_attribute("action", "withdraw_ticket")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Draws a winner for `round` (already validated as drawable by the caller),
/// transitions it to `Drawn`, advances global state to the next round, and
/// opens that new round - returning the payout messages plus, if the pool
/// has a nonzero weekly cut, the Weekly Round `ContributeToPool` `SubMsg`
/// separately (see `WEEKLY_CONTRIBUTION_REPLY_ID` doc comment for why it's a
/// `SubMsg`, not a plain message alongside the rest). Caller is responsible
/// for saving `round` (under its own, unchanged `round_id`) and `state`
/// afterward; this only mutates them in place plus whatever storage
/// `open_new_round`/`add_winning` touch directly. Shared by
/// `execute_draw_winner` (the separate post-window call) and
/// `execute_buy_ticket`'s atomic sold-out path (2026-08-24 audit fix).
fn perform_draw(
    storage: &mut dyn Storage,
    env: &Env,
    config: &Config,
    state: &mut GlobalState,
    round: &mut Round,
) -> StdResult<(Vec<CosmosMsg>, Option<SubMsg>)> {
    let winner_index = pick_winner_index(
        round.round_id,
        env.block.height,
        env.block.time.nanos(),
        &round.entrants,
    );
    let winner = round.entrants[winner_index].clone();

    let gross = round.pool;
    let prize = gross.multiply_ratio(PRIZE_BPS, BPS_DENOM);
    let next_carry = gross.multiply_ratio(NEXT_ROUND_BPS, BPS_DENOM);
    let weekly_cut = gross.multiply_ratio(WEEKLY_BPS, BPS_DENOM);
    let mut treasury_cut = gross.multiply_ratio(TREASURY_BPS, BPS_DENOM);
    let admin_cut = gross.multiply_ratio(ADMIN_BPS, BPS_DENOM);
    let allocated = prize + next_carry + weekly_cut + treasury_cut + admin_cut;
    // Integer division on the 5 shares can leave a few micro-units of dust;
    // it goes to the treasury rather than being lost.
    treasury_cut += gross.checked_sub(allocated).unwrap_or_default();

    round.status = RoundStatus::Drawn;
    round.winner = Some(winner.clone());
    round.prize_remaining = prize;
    round.drawn_at = Some(env.block.time);
    round.draw_height = Some(env.block.height);
    let finished_round_id = round.round_id;

    if !prize.is_zero() {
        add_winning(storage, winner.clone(), finished_round_id)?;
    }

    state.next_round_carry += next_carry;
    let carry_for_next = state.next_round_carry;
    state.current_round_id += 1;
    let new_round_id = state.current_round_id;
    state.next_round_carry = Uint128::zero();

    open_new_round(storage, env, new_round_id, carry_for_next)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !treasury_cut.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.treasury_address.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: treasury_cut,
                }],
            }
            .into(),
        );
    }
    if !admin_cut.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.admin_fee_address.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: admin_cut,
                }],
            }
            .into(),
        );
    }
    let weekly_submsg = if !weekly_cut.is_zero() {
        // Recorded so the reply handler knows how much to redirect to the
        // treasury if this fails - see PENDING_WEEKLY_CONTRIBUTION's doc
        // comment. Safe against overlap: each execute call only ever builds
        // one of these, and the only way a second could be dispatched before
        // this one's reply resolves is reentrancy - Weekly Round's
        // execute_contribute_to_pool dispatches no messages of its own today
        // (confirmed by reading it directly), so there's no path back into
        // this contract while this SubMsg is in flight. reply_on_error also
        // helps here even if that ever changed: a failed SubMsg discards
        // every state change made *inside* its own dispatch (including any
        // nested save to this same Item), so this reply always reads back
        // the value it just wrote, not one clobbered by a reentrant call.
        PENDING_WEEKLY_CONTRIBUTION.save(storage, &weekly_cut)?;
        Some(SubMsg::reply_on_error(
            WasmMsg::Execute {
                contract_addr: config.weekly_round_address.to_string(),
                msg: to_json_binary(&WeeklyRoundExecuteMsg::ContributeToPool {
                    source_wheel: env.contract.address.to_string(),
                    source_round_id: finished_round_id,
                })?,
                funds: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: weekly_cut,
                }],
            },
            WEEKLY_CONTRIBUTION_REPLY_ID,
        ))
    } else {
        None
    };

    Ok((messages, weekly_submsg))
}

pub fn execute_draw_winner(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Closed {
        return Err(ContractError::RoundNotClosed {});
    }
    let required_height = round.draw_after_height.unwrap_or(u64::MAX);
    if env.block.height < required_height {
        return Err(ContractError::DrawTooEarly { required_height });
    }
    // Ceiling on the draw window: past this, rearm to a fresh window based on
    // the current block instead of drawing, rather than leaving the window
    // open indefinitely (see `draw_window_blocks` doc comment on `Config`).
    // Not an error - a caller here is doing exactly the right thing (trying
    // to draw), the round just needs another pass through the keeper.
    // *Unless* the rearm cap (MAX_REARMS) is already spent (2026-08-24 audit
    // fix): rearming unconditionally here would let a patient off-chain
    // grinder keep re-rolling for a favorable block forever whenever nobody
    // else calls DrawWinner in the meantime. Once the cap is spent, there's
    // no more free re-roll for anyone - this call just draws right here, at
    // whatever height it landed on, instead of resetting the window again.
    if env.block.height >= required_height + config.draw_window_blocks && round.rearm_count < MAX_REARMS {
        round.rearm_count += 1;
        round.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
        ROUNDS.save(deps.storage, round.round_id, &round)?;
        return Ok(Response::new()
            .add_attribute("action", "rearm_draw_window")
            .add_attribute("round_id", round.round_id.to_string())
            .add_attribute("new_draw_after_height", round.draw_after_height.unwrap().to_string())
            .add_attribute("rearm_count", round.rearm_count.to_string()));
    }
    if (round.unique_players.len() as u32) < config.min_players {
        return Err(ContractError::NotEnoughPlayers {
            min_players: config.min_players,
        });
    }

    let (messages, weekly_submsg) = perform_draw(deps.storage, &env, &config, &mut state, &mut round)?;
    let finished_round_id = round.round_id;
    let winner = round.winner.clone().unwrap();
    let prize = round.prize_remaining;
    ROUNDS.save(deps.storage, round.round_id, &round)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_submessages(weekly_submsg)
        .add_attribute("action", "draw_winner")
        .add_attribute("round_id", finished_round_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("prize", prize.to_string()))
}

/// Handles the reply from the `ContributeToPool` `SubMsg` dispatched in
/// `perform_draw` (see `WEEKLY_CONTRIBUTION_REPLY_ID`'s doc comment for the
/// full rationale). `reply_on_error` only invokes this on failure - a
/// successful contribution never reaches here at all. Redirects the amount
/// that would have gone to Weekly Round to the treasury instead, rather than
/// leaving it stranded in this contract with no path to recovery (same
/// "never orphan funds" standard the project already holds itself to via
/// `SweepUstc`/`SweepExpiredPrize`). Safe to do: per CosmWasm/wasmd, a failed
/// `SubMsg`'s state changes - including the funds transfer bundled into
/// dispatching `WasmMsg::Execute` - are rolled back with it, so the amount is
/// still sitting in this contract's own balance when this runs, not actually
/// gone.
fn handle_weekly_contribution_reply(
    deps: DepsMut,
    result: SubMsgResult,
) -> Result<Response, ContractError> {
    // reply_on_error only ever dispatches this handler on failure - but
    // reply_on is a config choice on the SubMsg, not a compiler guarantee,
    // so this doesn't panic if some future edit switches the dispatch to
    // reply_always. An Ok reply just means the contribution went through
    // normally: nothing to redirect, and PENDING_WEEKLY_CONTRIBUTION is left
    // as-is - harmless, since it's only ever read right after being freshly
    // written by the next dispatch, never on its own.
    let error = match result {
        SubMsgResult::Ok(_) => return Ok(Response::new()),
        SubMsgResult::Err(e) => e,
    };
    let config = CONFIG.load(deps.storage)?;
    let amount = PENDING_WEEKLY_CONTRIBUTION.load(deps.storage)?;
    PENDING_WEEKLY_CONTRIBUTION.remove(deps.storage);

    let mut response = Response::new()
        .add_attribute("action", "weekly_contribution_failed")
        .add_attribute("error", error)
        .add_attribute("redirected_to_treasury", amount.to_string());
    if !amount.is_zero() {
        response = response.add_message(BankMsg::Send {
            to_address: config.treasury_address.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom.clone(),
                amount,
            }],
        });
    }
    Ok(response)
}

pub fn reply(deps: DepsMut, msg: Reply) -> Result<Response, ContractError> {
    match msg.id {
        WEEKLY_CONTRIBUTION_REPLY_ID => handle_weekly_contribution_reply(deps, msg.result),
        id => Err(ContractError::UnknownReplyId { id }),
    }
}

pub fn execute_redeem(
    deps: DepsMut,
    info: MessageInfo,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    if round.status != RoundStatus::Drawn {
        return Err(ContractError::RoundNotDrawn {});
    }
    let winner = round.winner.clone().ok_or(ContractError::RoundNotDrawn {})?;
    if info.sender != winner {
        return Err(ContractError::NotWinner { round_id });
    }
    if round.prize_remaining.is_zero() {
        return Err(ContractError::NothingToRedeem { round_id });
    }

    let sent_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.redemption_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if sent_amount.is_zero() {
        return Err(ContractError::NoFundsSent {});
    }

    let payout = std::cmp::min(sent_amount, round.prize_remaining);
    let refund = sent_amount - payout;
    round.prize_remaining -= payout;

    if round.prize_remaining.is_zero() {
        remove_winning(deps.storage, &winner, round_id)?;
    }
    ROUNDS.save(deps.storage, round_id, &round)?;
    add_redeemed(deps.storage, &winner, payout)?;

    let mut messages: Vec<CosmosMsg> = vec![BankMsg::Send {
        to_address: winner.to_string(),
        amount: vec![Coin {
            denom: config.ticket_denom.clone(),
            amount: payout,
        }],
    }
    .into()];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: winner.to_string(),
                amount: vec![Coin {
                    denom: config.redemption_denom.clone(),
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "redeem")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("payout", payout.to_string())
        .add_attribute("refund", refund.to_string()))
}

pub fn execute_sweep_ustc(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    let balance = deps
        .querier
        .query_balance(&env.contract.address, config.redemption_denom.clone())?;

    if balance.amount.is_zero() {
        return Ok(Response::new()
            .add_attribute("action", "sweep_ustc")
            .add_attribute("amount", "0"));
    }

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: config.treasury_address.to_string(),
            amount: vec![balance.clone()],
        })
        .add_attribute("action", "sweep_ustc")
        .add_attribute("amount", balance.amount.to_string()))
}

/// Anyone can call this once `unclaimed_deadline_days` have passed - no admin
/// discretion, no live redirection of funds. Handles two terminal round
/// states, both measured against the same deadline window: a `Drawn` round's
/// unredeemed `prize_remaining` (from `drawn_at`), or an `Expired` round's
/// abandoned, never-reclaimed ticket pool (from `expired_at`). Either way,
/// any legitimate wallet-recovery claim is handled off-chain by the
/// (multisig) treasury from there, not by this contract.
pub fn execute_sweep_expired_prize(
    deps: DepsMut,
    env: Env,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    let (swept_amount, reference_time) = match round.status {
        RoundStatus::Drawn => {
            if round.prize_remaining.is_zero() {
                return Err(ContractError::NothingToRedeem { round_id });
            }
            let drawn_at = round.drawn_at.ok_or(ContractError::RoundNotDrawn {})?;
            (round.prize_remaining, drawn_at)
        }
        RoundStatus::Expired => {
            if round.pool.is_zero() {
                return Err(ContractError::NothingToSweep { round_id });
            }
            let expired_at = round
                .expired_at
                .ok_or(ContractError::RoundNotExpired { round_id })?;
            (round.pool, expired_at)
        }
        _ => return Err(ContractError::RoundNotDrawn {}),
    };

    let deadline = reference_time.seconds() + config.unclaimed_deadline_days * 86400;
    if env.block.time.seconds() < deadline {
        return Err(ContractError::UnclaimedDeadlineNotReached { round_id });
    }

    let winner = round.winner.clone();
    match round.status {
        RoundStatus::Drawn => round.prize_remaining = Uint128::zero(),
        RoundStatus::Expired => {
            round.pool = Uint128::zero();
            round.entrants.clear();
            round.unique_players.clear();
        }
        _ => unreachable!("matched above"),
    }
    ROUNDS.save(deps.storage, round_id, &round)?;

    if let Some(winner) = winner {
        remove_winning(deps.storage, &winner, round_id)?;
    }

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: config.treasury_address.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom,
                amount: swept_amount,
            }],
        })
        .add_attribute("action", "sweep_expired_prize")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("amount", swept_amount.to_string()))
}

fn add_winning(storage: &mut dyn Storage, winner: Addr, round_id: u64) -> StdResult<()> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    if !winnings.contains(&round_id) {
        winnings.push(round_id);
    }
    WINNER_INDEX.save(storage, winner, &winnings)
}

fn remove_winning(storage: &mut dyn Storage, winner: &Addr, round_id: u64) -> StdResult<()> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    winnings.retain(|id| *id != round_id);
    if winnings.is_empty() {
        WINNER_INDEX.remove(storage, winner.clone());
    } else {
        WINNER_INDEX.save(storage, winner.clone(), &winnings)?;
    }
    Ok(())
}

fn add_invested(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> StdResult<()> {
    let current = TOTAL_INVESTED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_INVESTED.save(storage, wallet.clone(), &(current + amount))
}

fn subtract_invested(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> StdResult<()> {
    let current = TOTAL_INVESTED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_INVESTED.save(storage, wallet.clone(), &current.saturating_sub(amount))
}

fn add_redeemed(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> StdResult<()> {
    let current = TOTAL_REDEEMED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_REDEEMED.save(storage, wallet.clone(), &(current + amount))
}
