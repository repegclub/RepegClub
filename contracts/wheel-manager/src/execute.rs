use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Coin, CosmosMsg, DepsMut, Env, MessageInfo, Response, StdResult,
    Storage, Uint128, WasmMsg,
};

use crate::error::ContractError;
use crate::rand::pick_winner_index;
use crate::state::{Round, RoundStatus, CONFIG, ROUNDS, STATE, WINNER_INDEX};

const PRIZE_BPS: u128 = 6000; // 60%
const NEXT_ROUND_BPS: u128 = 500; // 5%
const WEEKLY_BPS: u128 = 2000; // 20%
const TREASURY_BPS: u128 = 1200; // 12%
const ADMIN_BPS: u128 = 300; // 3%
const BPS_DENOM: u128 = 10000;

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
        closed_at: None,
        draw_after_height: None,
        drawn_at: None,
        winner: None,
        prize_remaining: Uint128::zero(),
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
    let state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
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

    let auto_closed = round.unique_players.len() as u32 >= config.max_players;
    if auto_closed {
        round.status = RoundStatus::Closed;
        round.closed_at = Some(env.block.time);
        round.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    }

    ROUNDS.save(deps.storage, round.round_id, &round)?;

    Ok(Response::new()
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
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    let timeout_elapsed =
        env.block.time.seconds() >= round.opened_at.seconds() + config.round_timeout_seconds;

    if !(reached_max || (timeout_elapsed && has_min)) {
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
    if (round.unique_players.len() as u32) < config.min_players {
        return Err(ContractError::NotEnoughPlayers {
            min_players: config.min_players,
        });
    }

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
    let finished_round_id = round.round_id;
    ROUNDS.save(deps.storage, round.round_id, &round)?;

    if !prize.is_zero() {
        add_winning(deps.storage, winner.clone(), finished_round_id)?;
    }

    state.next_round_carry += next_carry;
    let carry_for_next = state.next_round_carry;
    state.current_round_id += 1;
    let new_round_id = state.current_round_id;
    state.next_round_carry = Uint128::zero();
    STATE.save(deps.storage, &state)?;

    open_new_round(deps.storage, &env, new_round_id, carry_for_next)?;

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
    if !weekly_cut.is_zero() {
        messages.push(
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
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "draw_winner")
        .add_attribute("round_id", finished_round_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("prize", prize.to_string()))
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

/// Anyone can call this once `unclaimed_deadline_days` have passed since the
/// round was drawn - no admin discretion, no live redirection of an active
/// prize. Sweeps whatever's left of the prize to the treasury; from there,
/// any legitimate wallet-recovery claim is handled off-chain by the
/// (multisig) treasury, not by this contract.
pub fn execute_sweep_expired_prize(
    deps: DepsMut,
    env: Env,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;
    if round.status != RoundStatus::Drawn {
        return Err(ContractError::RoundNotDrawn {});
    }
    if round.prize_remaining.is_zero() {
        return Err(ContractError::NothingToRedeem { round_id });
    }
    let drawn_at = round.drawn_at.ok_or(ContractError::RoundNotDrawn {})?;
    let deadline = drawn_at.seconds() + config.unclaimed_deadline_days * 86400;
    if env.block.time.seconds() < deadline {
        return Err(ContractError::UnclaimedDeadlineNotReached { round_id });
    }

    let swept_amount = round.prize_remaining;
    let winner = round.winner.clone();
    round.prize_remaining = Uint128::zero();
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
