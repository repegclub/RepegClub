use cosmwasm_std::{
    Addr, BankMsg, Coin, CosmosMsg, DepsMut, Env, MessageInfo, Response, StdResult, Storage,
    Timestamp, Uint128,
};

use crate::error::ContractError;
use crate::rand::pick_winner_index;
use crate::state::{
    Config, RoundStatus, Week, CONFIG, STATE, TOTAL_INVESTED, TOTAL_REDEEMED, WEEKS, WINNER_INDEX,
};

const PRIZE_BPS: u128 = 8500; // 85%
const TREASURY_BPS: u128 = 1200; // 12%
const ADMIN_BPS: u128 = 300; // 3%
const BPS_DENOM: u128 = 10000;
const SECONDS_PER_DAY: u64 = 86400;

pub fn open_new_week(
    storage: &mut dyn Storage,
    env: &Env,
    week_id: u64,
    carry_in_contributions: Uint128,
) -> StdResult<()> {
    let week = Week {
        week_id,
        status: RoundStatus::Open,
        entrants: vec![],
        unique_players: vec![],
        ticket_sales_pool: Uint128::zero(),
        wheel_contributions: carry_in_contributions,
        ticket_payments: vec![],
        opened_at: env.block.time,
        closed_at: None,
        draw_after_height: None,
        drawn_at: None,
        draw_height: None,
        winner: None,
        prize_remaining: Uint128::zero(),
        expired_at: None,
    };
    WEEKS.save(storage, week_id, &week)
}

pub fn today_price(config: &Config, week: &Week, now: Timestamp) -> Uint128 {
    let elapsed_days = now.seconds().saturating_sub(week.opened_at.seconds()) / SECONDS_PER_DAY;
    config.base_ticket_price + config.price_increment_per_day * Uint128::from(elapsed_days)
}

pub fn execute_contribute_to_pool(
    deps: DepsMut,
    info: MessageInfo,
    source_wheel: String,
    source_round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;

    let sent_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.ticket_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if sent_amount.is_zero() {
        return Err(ContractError::NoFundsSent {});
    }

    week.wheel_contributions += sent_amount;
    WEEKS.save(deps.storage, week.week_id, &week)?;

    Ok(Response::new()
        .add_attribute("action", "contribute_to_pool")
        .add_attribute("source_wheel", source_wheel)
        .add_attribute("source_round_id", source_round_id.to_string())
        .add_attribute("amount", sent_amount.to_string()))
}

/// No single wallet may hold more than half of a week's `max_players` worth
/// of tickets - bounds the worst-case size of `entrants` (so
/// `DrawWeeklyWinner`'s winner-picking hash can never grow unbounded) while
/// still leaving room for the weighted-wheel "buy more, better odds" feature.
/// Not a separate config field on purpose - always derived from `max_players`.
pub fn max_tickets_per_wallet(max_players: u32) -> u32 {
    std::cmp::max(1, max_players / 2)
}

pub fn execute_buy_weekly_ticket(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;

    if week.status != RoundStatus::Open {
        return Err(ContractError::WeekNotOpen {});
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
        week.status = RoundStatus::Closed;
        week.closed_at = Some(env.block.time);
        week.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    }

    WEEKS.save(deps.storage, week.week_id, &week)?;
    add_invested(deps.storage, &info.sender, sent_amount)?;

    Ok(Response::new()
        .add_attribute("action", "buy_weekly_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("week_id", week.week_id.to_string())
        .add_attribute("price_paid", price.to_string())
        .add_attribute("auto_closed", auto_closed.to_string()))
}

pub fn execute_close_week(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let state = STATE.load(deps.storage)?;
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

    week.status = RoundStatus::Closed;
    week.closed_at = Some(env.block.time);
    week.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    WEEKS.save(deps.storage, week.week_id, &week)?;

    Ok(Response::new()
        .add_attribute("action", "close_week")
        .add_attribute("week_id", week.week_id.to_string()))
}

/// Permissionless. Only fires when `min_players` was never reached and
/// `round_duration_days` has elapsed - the counterpart to `CloseWeek` for a
/// week that never got enough interest. Opens the next week immediately so
/// the game isn't stuck waiting on this one to be resolved.
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
    STATE.save(deps.storage, &state)?;
    open_new_week(deps.storage, &env, new_week_id, carry_forward)?;

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

pub fn execute_draw_weekly_winner(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut week = WEEKS.load(deps.storage, state.current_week_id)?;

    if week.status != RoundStatus::Closed {
        return Err(ContractError::WeekNotClosed {});
    }
    let required_height = week.draw_after_height.unwrap_or(u64::MAX);
    if env.block.height < required_height {
        return Err(ContractError::DrawTooEarly { required_height });
    }
    // Ceiling on the draw window - see wheel-manager's execute_draw_winner
    // for the full rationale. Not an error, just a rearm to a fresh window.
    if env.block.height >= required_height + config.draw_window_blocks {
        week.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
        WEEKS.save(deps.storage, week.week_id, &week)?;
        return Ok(Response::new()
            .add_attribute("action", "rearm_draw_window")
            .add_attribute("week_id", week.week_id.to_string())
            .add_attribute("new_draw_after_height", week.draw_after_height.unwrap().to_string()));
    }
    if (week.unique_players.len() as u32) < config.min_players {
        return Err(ContractError::NotEnoughPlayers {
            min_players: config.min_players,
        });
    }

    let winner_index = pick_winner_index(
        week.week_id,
        env.block.height,
        env.block.time.nanos(),
        &week.entrants,
    );
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
    week.draw_height = Some(env.block.height);
    let finished_week_id = week.week_id;
    WEEKS.save(deps.storage, week.week_id, &week)?;

    if !prize.is_zero() {
        add_winning(deps.storage, winner.clone(), finished_week_id)?;
    }

    state.current_week_id += 1;
    let new_week_id = state.current_week_id;
    STATE.save(deps.storage, &state)?;
    open_new_week(deps.storage, &env, new_week_id, Uint128::zero())?;

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
        .add_attribute("action", "draw_weekly_winner")
        .add_attribute("week_id", finished_week_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("prize", prize.to_string()))
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

fn add_winning(storage: &mut dyn Storage, winner: Addr, week_id: u64) -> StdResult<()> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    if !winnings.contains(&week_id) {
        winnings.push(week_id);
    }
    WINNER_INDEX.save(storage, winner, &winnings)
}

fn remove_winning(storage: &mut dyn Storage, winner: &Addr, week_id: u64) -> StdResult<()> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    winnings.retain(|id| *id != week_id);
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
