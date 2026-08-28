use cosmwasm_std::{
    Addr, BankMsg, Coin, CosmosMsg, DepsMut, Empty, Env, HexBinary, MessageInfo, Response,
    Storage, Timestamp, Uint128,
};
use sha2::{Digest, Sha256};

use crate::error::ContractError;
use crate::rand::pick_winner_index;
use crate::state::{
    Config, GlobalState, RoundStatus, Week, CONFIG, COMMIT_QUEUE, PENDING_CONTRIBUTIONS,
    REVEAL_QUEUE, STATE, TOTAL_INVESTED, TOTAL_REDEEMED, USED_COMMITS, WEEKS, WINNER_INDEX,
};

const PRIZE_BPS: u128 = 8500; // 85%
const TREASURY_BPS: u128 = 1200; // 12%
const ADMIN_BPS: u128 = 300; // 3%
const BPS_DENOM: u128 = 10000;
const SECONDS_PER_DAY: u64 = 86400;

/// See wheel-manager's matching constants' doc comments - same mechanism.
pub const EXPIRE_FINALIZE_DELAY_BLOCKS: u64 = 100;
pub const EXPIRE_CHALLENGE_BLOCKS: u64 = 100;
/// See wheel-manager's matching `REVEAL_PRIORITY_MARGIN_BLOCKS` (Ronda 10
/// audit fix, Opus, CYOL-2/WM-1).
pub const REVEAL_PRIORITY_MARGIN_BLOCKS: u64 = 20;
pub const REQUEST_EXPIRE_TTL_BLOCKS: u64 = 200;
pub const PUSH_COMMITS_MAX_BATCH: u32 = 50;
pub const MAX_COMMIT_QUEUE_LEN: u32 = 500;

pub fn open_new_week(storage: &mut dyn Storage, env: &Env, week_id: u64) -> Result<(), ContractError> {
    if WEEKS.has(storage, week_id) {
        return Err(ContractError::WeekAlreadyExists { week_id });
    }
    let commit_used = COMMIT_QUEUE.pop_front(storage)?;
    let week = Week {
        week_id,
        status: RoundStatus::Open,
        entrants: vec![],
        unique_players: vec![],
        ticket_sales_pool: Uint128::zero(),
        wheel_contributions: Uint128::zero(),
        ticket_payments: vec![],
        opened_at: env.block.time,
        closed_at: None,
        closed_at_height: None,
        commit_used,
        revealed_preimage: None,
        expire_requested_at_height: None,
        expiry_pending_since_height: None,
        drawn_at: None,
        winner: None,
        prize_remaining: Uint128::zero(),
        expired_at: None,
    };
    WEEKS.save(storage, week_id, &week)?;
    Ok(())
}

/// See wheel-manager's matching `route_carry` doc comment - same mechanism,
/// applied to `wheel_contributions` instead of a self-generated carry.
pub fn route_carry(storage: &mut dyn Storage, amount: Uint128) -> Result<(), ContractError> {
    if amount.is_zero() {
        return Ok(());
    }
    let mut pending = PENDING_CONTRIBUTIONS.may_load(storage)?.unwrap_or_default();
    pending += amount;
    let state = STATE.load(storage)?;
    if let Some(mut current) = WEEKS.may_load(storage, state.current_week_id)? {
        if current.status == RoundStatus::Open {
            current.wheel_contributions += pending;
            pending = Uint128::zero();
            WEEKS.save(storage, current.week_id, &current)?;
        }
    }
    PENDING_CONTRIBUTIONS.save(storage, &pending)?;
    Ok(())
}

/// Deliberately infallible by week status (or by `commit_used`/queue state -
/// there is no such check here at all): this is called from wheel-manager as
/// a plain message (`reply_on: Never`), so if it could fail by state, it
/// would fail wheel-manager's entire reveal transaction, and under v9 that
/// transaction is the only way a round resolves at all (see the project's
/// Obsidian design notes on the Ronda 9 finding this guards against - v8's
/// `Closed`-awaiting-reveal state is exactly the kind of state a "reject if
/// not Open" gate would trip on, added "for symmetry" by an implementer who
/// didn't trace this cross-contract dependency). The only validation here is
/// on the funds actually sent, which wheel-manager already guarantees are
/// non-zero before calling this.
pub fn execute_contribute_to_pool(
    deps: DepsMut,
    info: MessageInfo,
    source_wheel: String,
    source_round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let sent_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.ticket_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if sent_amount.is_zero() {
        return Err(ContractError::NoFundsSent {});
    }
    route_carry(deps.storage, sent_amount)?;

    Ok(Response::new()
        .add_attribute("action", "contribute_to_pool")
        .add_attribute("source_wheel", source_wheel)
        .add_attribute("source_round_id", source_round_id.to_string())
        .add_attribute("amount", sent_amount.to_string()))
}

pub fn today_price(config: &Config, week: &Week, now: Timestamp) -> Uint128 {
    let elapsed_days = now.seconds().saturating_sub(week.opened_at.seconds()) / SECONDS_PER_DAY;
    config.base_ticket_price + config.price_increment_per_day * Uint128::from(elapsed_days)
}

/// See wheel-manager's matching `max_tickets_per_wallet`.
pub fn max_tickets_per_wallet(max_players: u32) -> u32 {
    std::cmp::max(1, max_players / 2)
}

pub fn execute_buy_weekly_ticket(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;

    if week.status != RoundStatus::Open {
        return Err(ContractError::WeekNotOpen {});
    }
    if week.commit_used.is_none() {
        return Err(ContractError::WeekNotSeeded {});
    }

    // Once the week is stale (never reached min_players within
    // round_duration_days), stop accepting tickets - it must go through
    // ExpireWeek + ReclaimTicket instead, not keep growing indefinitely.
    let has_min = week.unique_players.len() as u32 >= config.min_players;
    let stale = !has_min
        && env.block.time.seconds()
            >= week.opened_at.seconds() + config.round_duration_days * SECONDS_PER_DAY;
    if stale {
        return Err(ContractError::WeekExpired {});
    }

    let price = today_price(&config, &week, env.block.time);
    let sent_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.ticket_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if sent_amount != price {
        return Err(ContractError::WrongTicketPayment {
            expected: price,
            denom: config.ticket_denom.clone(),
        });
    }

    let cap = max_tickets_per_wallet(config.max_players);
    let already_bought = week.entrants.iter().filter(|e| **e == info.sender).count() as u32;
    if already_bought >= cap {
        return Err(ContractError::TicketCapExceeded { max_per_wallet: cap });
    }

    week.entrants.push(info.sender.clone());
    week.ticket_sales_pool += sent_amount;
    if !week.unique_players.contains(&info.sender) {
        week.unique_players.push(info.sender.clone());
    }
    match week.ticket_payments.iter_mut().find(|(addr, _)| *addr == info.sender) {
        Some((_, paid)) => *paid += sent_amount,
        None => week.ticket_payments.push((info.sender.clone(), sent_amount)),
    }

    let auto_closed = week.unique_players.len() as u32 >= config.max_players;
    if auto_closed {
        close_week_and_advance(deps.storage, &env, &mut state, &mut week)?;
        STATE.save(deps.storage, &state)?;
    } else {
        WEEKS.save(deps.storage, week.week_id, &week)?;
    }
    add_invested(deps.storage, &info.sender, sent_amount)?;

    Ok(Response::new()
        .add_attribute("action", "buy_weekly_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("week_id", week.week_id.to_string())
        .add_attribute("price_paid", price.to_string())
        .add_attribute("auto_closed", auto_closed.to_string()))
}

/// See wheel-manager's matching `close_round_and_advance` doc comment - same
/// mechanism: closes, enqueues for reveal, and opens the successor
/// atomically, without ever drawing a winner itself.
fn close_week_and_advance(
    storage: &mut dyn Storage,
    env: &Env,
    state: &mut GlobalState,
    week: &mut Week,
) -> Result<(), ContractError> {
    week.status = RoundStatus::Closed;
    week.closed_at = Some(env.block.time);
    week.closed_at_height = Some(env.block.height);
    WEEKS.save(storage, week.week_id, week)?;
    REVEAL_QUEUE.push_back(storage, &week.week_id)?;

    state.current_week_id += 1;
    open_new_week(storage, env, state.current_week_id)?;
    Ok(())
}

pub fn execute_close_week(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;

    if week.status != RoundStatus::Open {
        return Err(ContractError::WeekNotOpen {});
    }

    let reached_max = week.unique_players.len() as u32 >= config.max_players;
    let has_min = week.unique_players.len() as u32 >= config.min_players;
    let duration_elapsed = env.block.time.seconds()
        >= week.opened_at.seconds() + config.round_duration_days * SECONDS_PER_DAY;

    if !(reached_max || (duration_elapsed && has_min)) {
        return Err(ContractError::CannotCloseWeek {});
    }

    let week_id = week.week_id;
    close_week_and_advance(deps.storage, &env, &mut state, &mut week)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "close_week")
        .add_attribute("week_id", week_id.to_string()))
}

/// Permissionless. Only fires when `min_players` was never reached and
/// `round_duration_days` has elapsed - the counterpart to `CloseWeek` for a
/// week that never got enough interest. Opens the next week immediately so
/// the game isn't stuck waiting on this one to be resolved. This week never
/// entered `REVEAL_QUEUE` (it never reached `Closed`), so unlike
/// `claim_expired_week` this is the one place that's still correct to open
/// a successor itself.
pub fn execute_expire_week(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;

    if week.status != RoundStatus::Open {
        return Err(ContractError::WeekNotOpen {});
    }
    let has_min = week.unique_players.len() as u32 >= config.min_players;
    let duration_elapsed = env.block.time.seconds()
        >= week.opened_at.seconds() + config.round_duration_days * SECONDS_PER_DAY;
    if has_min || !duration_elapsed {
        return Err(ContractError::CannotExpireWeek {});
    }

    // Only ticket money is owed to specific buyers (reclaimable below);
    // wheel_contributions came from Wheel Manager instances, isn't anyone's
    // individual money, and rolls forward to the next week instead of
    // sitting stranded here.
    let reclaimable_pool = week.ticket_sales_pool;
    let carry_forward = week.wheel_contributions;
    week.wheel_contributions = Uint128::zero();
    week.status = RoundStatus::Expired;
    week.expired_at = Some(env.block.time);
    let finished_week_id = week.week_id;
    WEEKS.save(deps.storage, week.week_id, &week)?;

    state.current_week_id += 1;
    let new_week_id = state.current_week_id;
    open_new_week(deps.storage, &env, new_week_id)?;
    // STATE must be saved before route_carry: it re-reads GlobalState from
    // storage internally (unlike wheel-manager's version, which takes it by
    // reference), so calling it before this save would see the *old*
    // current_week_id - exactly the ordering bug the project's Obsidian v9
    // design notes flagged as a risk (Fix L). Caught by
    // `expire_week_carries_wheel_contributions_forward_but_not_ticket_money`
    // failing when this was ordered the other way around.
    STATE.save(deps.storage, &state)?;
    route_carry(deps.storage, carry_forward)?;

    Ok(Response::new()
        .add_attribute("action", "expire_week")
        .add_attribute("week_id", finished_week_id.to_string())
        .add_attribute("reclaimable_pool", reclaimable_pool.to_string())
        .add_attribute("carried_forward", carry_forward.to_string()))
}

/// Callable by any wallet that bought at least one ticket in an `Expired`
/// week - refunds exactly what that wallet paid and removes its entries
/// from the week, so it can't be reclaimed twice.
pub fn execute_reclaim_ticket(
    deps: DepsMut,
    info: MessageInfo,
    week_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut week = WEEKS
        .may_load(deps.storage, week_id)?
        .ok_or(ContractError::WeekNotFound { week_id })?;

    if week.status != RoundStatus::Expired {
        return Err(ContractError::WeekNotExpired { week_id });
    }

    let idx = week.ticket_payments.iter().position(|(addr, _)| *addr == info.sender);
    let Some(idx) = idx else {
        return Err(ContractError::NotAnEntrant { week_id });
    };
    let refund = week.ticket_payments.remove(idx).1;
    week.entrants.retain(|e| *e != info.sender);
    week.unique_players.retain(|e| *e != info.sender);
    week.ticket_sales_pool = week.ticket_sales_pool.checked_sub(refund).unwrap_or_default();
    WEEKS.save(deps.storage, week_id, &week)?;
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
        .add_attribute("week_id", week_id.to_string())
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Self-service refund for a wallet's own tickets in the current week,
/// callable only while `min_players` hasn't been reached yet - deliberately
/// no minimum wait time before a second player shows up, since the player
/// can simply leave whenever they lose interest instead of being locked in.
pub fn execute_withdraw_ticket(
    deps: DepsMut,
    info: MessageInfo,
    week_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut week = WEEKS
        .may_load(deps.storage, week_id)?
        .ok_or(ContractError::WeekNotFound { week_id })?;

    if week.status != RoundStatus::Open {
        return Err(ContractError::WeekNotOpen {});
    }
    if week.unique_players.len() as u32 >= config.min_players {
        return Err(ContractError::WeekAlreadyLocked { week_id });
    }

    let idx = week.ticket_payments.iter().position(|(addr, _)| *addr == info.sender);
    let Some(idx) = idx else {
        return Err(ContractError::NotAnEntrant { week_id });
    };
    let refund = week.ticket_payments.remove(idx).1;
    week.entrants.retain(|e| *e != info.sender);
    week.unique_players.retain(|e| *e != info.sender);
    week.ticket_sales_pool = week.ticket_sales_pool.checked_sub(refund).unwrap_or_default();
    WEEKS.save(deps.storage, week_id, &week)?;
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
        .add_attribute("week_id", week_id.to_string())
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Reveals the winner for the week at the front of `REVEAL_QUEUE` - see
/// wheel-manager's matching `execute_reveal_draw` doc comment.
pub fn execute_reveal_draw(
    deps: DepsMut,
    env: Env,
    week_id: u64,
    preimage: HexBinary,
) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != week_id {
        return Err(ContractError::QueueMismatch { front, week_id });
    }

    let config = CONFIG.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, week_id)?;
    if week.status != RoundStatus::Closed && week.status != RoundStatus::ExpiryPending {
        return Err(ContractError::WeekNotRevealable {});
    }
    let commit = week.commit_used.clone().ok_or(ContractError::WeekNotSeeded {})?;
    let digest = Sha256::digest(preimage.as_slice());
    if digest.as_slice() != commit.as_slice() {
        return Err(ContractError::BadPreimage {});
    }
    if week.unique_players.is_empty() {
        return Err(ContractError::NotEnoughPlayers { min_players: 0 });
    }

    let winner_index = pick_winner_index(&env.contract.address, week_id, preimage.as_slice(), &week.entrants);
    let winner = week.entrants[winner_index].clone();

    let gross = week.pool();
    let prize = gross.multiply_ratio(PRIZE_BPS, BPS_DENOM);
    let mut treasury_cut = gross.multiply_ratio(TREASURY_BPS, BPS_DENOM);
    let admin_cut = gross.multiply_ratio(ADMIN_BPS, BPS_DENOM);
    let allocated = prize + treasury_cut + admin_cut;
    treasury_cut += gross.checked_sub(allocated).unwrap_or_default();

    week.status = RoundStatus::Drawn;
    week.winner = Some(winner.clone());
    week.prize_remaining = prize;
    week.drawn_at = Some(env.block.time);
    week.revealed_preimage = Some(preimage);
    week.expire_requested_at_height = None;
    week.expiry_pending_since_height = None;
    let finished_week_id = week.week_id;
    WEEKS.save(deps.storage, week.week_id, &week)?;
    REVEAL_QUEUE.pop_front(deps.storage)?; // safe: front == week_id, already confirmed above

    if !prize.is_zero() {
        add_winning(deps.storage, winner.clone(), finished_week_id)?;
    }

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

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "reveal_draw")
        .add_attribute("week_id", finished_week_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("prize", prize.to_string()))
}

/// Admin-only. See wheel-manager's matching `execute_push_commits`.
pub fn execute_push_commits(
    deps: DepsMut,
    info: MessageInfo,
    commits: Vec<HexBinary>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    if commits.is_empty() || commits.len() as u32 > PUSH_COMMITS_MAX_BATCH {
        return Err(ContractError::InvalidCommitBatch { max: PUSH_COMMITS_MAX_BATCH });
    }
    let current_len = COMMIT_QUEUE.len(deps.storage)?;
    if current_len + commits.len() as u32 > MAX_COMMIT_QUEUE_LEN {
        return Err(ContractError::CommitQueueFull { max: MAX_COMMIT_QUEUE_LEN });
    }

    let mut seen_in_batch: Vec<HexBinary> = Vec::with_capacity(commits.len());
    for commit in &commits {
        if commit.len() != 32 {
            return Err(ContractError::InvalidCommitLength {});
        }
        if USED_COMMITS.has(deps.storage, commit.as_slice()) || seen_in_batch.contains(commit) {
            return Err(ContractError::CommitAlreadyUsed {});
        }
        seen_in_batch.push(commit.clone());
    }
    for commit in &commits {
        USED_COMMITS.save(deps.storage, commit.as_slice(), &Empty {})?;
        COMMIT_QUEUE.push_back(deps.storage, commit)?;
    }

    Ok(Response::new()
        .add_attribute("action", "push_commits")
        .add_attribute("count", commits.len().to_string()))
}

/// Permissionless backfill - see wheel-manager's matching `execute_assign_commit`.
pub fn execute_assign_commit(deps: DepsMut) -> Result<Response, ContractError> {
    let state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;
    if week.status != RoundStatus::Open || !week.entrants.is_empty() {
        return Err(ContractError::CannotAssignCommit {});
    }
    if week.commit_used.is_some() {
        return Err(ContractError::CommitAlreadyAssigned {});
    }
    let commit = COMMIT_QUEUE.pop_front(deps.storage)?.ok_or(ContractError::NoCommitsAvailable {})?;
    week.commit_used = Some(commit);
    WEEKS.save(deps.storage, week.week_id, &week)?;

    Ok(Response::new()
        .add_attribute("action", "assign_commit")
        .add_attribute("week_id", week.week_id.to_string()))
}

/// Permissionless. First step of the 3-phase expiration - see wheel-manager's
/// matching `execute_request_expire_closed_round`, including the front-of-
/// queue requirement (Ronda 10 audit fix, Opus, WM-1/medium - see that
/// function's own doc comment).
pub fn execute_request_expire_closed_week(
    deps: DepsMut,
    env: Env,
    week_id: u64,
) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != week_id {
        return Err(ContractError::QueueMismatch { front, week_id });
    }
    let config = CONFIG.load(deps.storage)?;
    let mut week = WEEKS
        .may_load(deps.storage, week_id)?
        .ok_or(ContractError::WeekNotFound { week_id })?;
    if week.status != RoundStatus::Closed {
        return Err(ContractError::WeekNotClosedForExpiry { week_id });
    }
    let closed_at = week.closed_at.ok_or(ContractError::WeekNotClosedForExpiry { week_id })?;
    if env.block.time.seconds() < closed_at.seconds() + config.max_reveal_age_seconds {
        return Err(ContractError::RevealNotYetOverdue { week_id });
    }
    let request_live = week
        .expire_requested_at_height
        .is_some_and(|h| env.block.height < h + REQUEST_EXPIRE_TTL_BLOCKS);
    if request_live {
        return Err(ContractError::ExpireAlreadyRequested { week_id });
    }
    week.expire_requested_at_height = Some(env.block.height);
    WEEKS.save(deps.storage, week_id, &week)?;

    Ok(Response::new()
        .add_attribute("action", "request_expire_closed_week")
        .add_attribute("week_id", week_id.to_string()))
}

/// Permissionless. Second step - see wheel-manager's matching
/// `execute_finalize_expire_closed_round`, including the front-of-queue
/// requirement (Ronda 10 audit fix, Opus, WM-1/medium).
pub fn execute_finalize_expire_closed_week(
    deps: DepsMut,
    env: Env,
    week_id: u64,
) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != week_id {
        return Err(ContractError::QueueMismatch { front, week_id });
    }
    let mut week = WEEKS
        .may_load(deps.storage, week_id)?
        .ok_or(ContractError::WeekNotFound { week_id })?;
    if week.status != RoundStatus::Closed {
        return Err(ContractError::WeekNotClosedForExpiry { week_id });
    }
    let requested_at = week
        .expire_requested_at_height
        .ok_or(ContractError::ExpireNotRequested { week_id })?;
    if env.block.height >= requested_at + REQUEST_EXPIRE_TTL_BLOCKS {
        return Err(ContractError::ExpireRequestExpired { week_id });
    }
    if env.block.height < requested_at + EXPIRE_FINALIZE_DELAY_BLOCKS {
        return Err(ContractError::FinalizeDelayNotElapsed { week_id });
    }
    week.status = RoundStatus::ExpiryPending;
    week.expiry_pending_since_height = Some(env.block.height);
    WEEKS.save(deps.storage, week_id, &week)?;

    Ok(Response::new()
        .add_attribute("action", "finalize_expire_closed_week")
        .add_attribute("week_id", week_id.to_string()))
}

/// Permissionless. Final step - see wheel-manager's matching
/// `claim_expired_round`. Never touches `state.current_week_id` or opens
/// anything - the successor week already opened when this one closed.
pub fn claim_expired_week(deps: DepsMut, env: Env, week_id: u64) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != week_id {
        return Err(ContractError::QueueMismatch { front, week_id });
    }
    let mut week = WEEKS.load(deps.storage, week_id)?;
    if week.status != RoundStatus::ExpiryPending {
        return Err(ContractError::WeekNotExpiryPending { week_id });
    }
    let pending_since = week.expiry_pending_since_height.ok_or(ContractError::WeekNotExpiryPending { week_id })?;
    if env.block.height < pending_since + EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS {
        return Err(ContractError::ChallengeWindowOpen { week_id });
    }

    let reclaimable_pool = week.ticket_sales_pool;
    let carry_forward = week.wheel_contributions;
    week.wheel_contributions = Uint128::zero();
    week.status = RoundStatus::Expired;
    week.expired_at = Some(env.block.time);
    WEEKS.save(deps.storage, week_id, &week)?;
    REVEAL_QUEUE.pop_front(deps.storage)?; // safe: front == week_id, already confirmed above

    route_carry(deps.storage, carry_forward)?;

    Ok(Response::new()
        .add_attribute("action", "claim_expired_week")
        .add_attribute("week_id", week_id.to_string())
        .add_attribute("reclaimable_pool", reclaimable_pool.to_string())
        .add_attribute("carried_forward", carry_forward.to_string()))
}

pub fn execute_redeem(deps: DepsMut, info: MessageInfo, week_id: u64) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut week = WEEKS
        .may_load(deps.storage, week_id)?
        .ok_or(ContractError::WeekNotFound { week_id })?;

    if week.status != RoundStatus::Drawn {
        return Err(ContractError::WeekNotDrawn {});
    }
    let winner = week.winner.clone().ok_or(ContractError::WeekNotDrawn {})?;
    if info.sender != winner {
        return Err(ContractError::NotWinner { week_id });
    }
    if week.prize_remaining.is_zero() {
        return Err(ContractError::NothingToRedeem { week_id });
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

    let payout = std::cmp::min(sent_amount, week.prize_remaining);
    let refund = sent_amount - payout;
    week.prize_remaining -= payout;

    if week.prize_remaining.is_zero() {
        remove_winning(deps.storage, &winner, week_id)?;
    }
    WEEKS.save(deps.storage, week_id, &week)?;
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
        .add_attribute("week_id", week_id.to_string())
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
/// discretion, no live redirection of funds. Handles two terminal week
/// states, both measured against the same deadline window: a `Drawn` week's
/// unredeemed `prize_remaining` (from `drawn_at`), or an `Expired` week's
/// abandoned, never-reclaimed ticket pool (from `expired_at`). Either way,
/// any legitimate wallet-recovery claim is handled off-chain by the
/// (multisig) treasury from there, not by this contract.
pub fn execute_sweep_expired_prize(
    deps: DepsMut,
    env: Env,
    week_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut week = WEEKS
        .may_load(deps.storage, week_id)?
        .ok_or(ContractError::WeekNotFound { week_id })?;

    let (swept_amount, reference_time) = match week.status {
        RoundStatus::Drawn => {
            if week.prize_remaining.is_zero() {
                return Err(ContractError::NothingToRedeem { week_id });
            }
            let drawn_at = week.drawn_at.ok_or(ContractError::WeekNotDrawn {})?;
            (week.prize_remaining, drawn_at)
        }
        RoundStatus::Expired => {
            if week.ticket_sales_pool.is_zero() {
                return Err(ContractError::NothingToSweep { week_id });
            }
            let expired_at = week
                .expired_at
                .ok_or(ContractError::WeekNotExpired { week_id })?;
            (week.ticket_sales_pool, expired_at)
        }
        _ => return Err(ContractError::WeekNotDrawn {}),
    };

    let deadline = reference_time.seconds() + config.unclaimed_deadline_days * 86400;
    if env.block.time.seconds() < deadline {
        return Err(ContractError::UnclaimedDeadlineNotReached { week_id });
    }

    let winner = week.winner.clone();
    match week.status {
        RoundStatus::Drawn => week.prize_remaining = Uint128::zero(),
        RoundStatus::Expired => {
            week.ticket_sales_pool = Uint128::zero();
            week.entrants.clear();
            week.unique_players.clear();
            week.ticket_payments.clear();
        }
        _ => unreachable!("matched above"),
    }
    WEEKS.save(deps.storage, week_id, &week)?;

    if let Some(winner) = winner {
        remove_winning(deps.storage, &winner, week_id)?;
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
        .add_attribute("week_id", week_id.to_string())
        .add_attribute("amount", swept_amount.to_string()))
}

fn add_winning(storage: &mut dyn Storage, winner: Addr, week_id: u64) -> Result<(), ContractError> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    if !winnings.contains(&week_id) {
        winnings.push(week_id);
    }
    WINNER_INDEX.save(storage, winner, &winnings)?;
    Ok(())
}

fn remove_winning(storage: &mut dyn Storage, winner: &Addr, week_id: u64) -> Result<(), ContractError> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    winnings.retain(|id| *id != week_id);
    if winnings.is_empty() {
        WINNER_INDEX.remove(storage, winner.clone());
    } else {
        WINNER_INDEX.save(storage, winner.clone(), &winnings)?;
    }
    Ok(())
}

fn add_invested(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> Result<(), ContractError> {
    let current = TOTAL_INVESTED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_INVESTED.save(storage, wallet.clone(), &(current + amount))?;
    Ok(())
}

fn subtract_invested(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> Result<(), ContractError> {
    let current = TOTAL_INVESTED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_INVESTED.save(storage, wallet.clone(), &current.saturating_sub(amount))?;
    Ok(())
}

fn add_redeemed(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> Result<(), ContractError> {
    let current = TOTAL_REDEEMED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_REDEEMED.save(storage, wallet.clone(), &(current + amount))?;
    Ok(())
}
