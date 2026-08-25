use cosmwasm_std::{
    entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult, Uint128,
};

use crate::error::ContractError;
use crate::execute::{
    execute_buy_weekly_ticket, execute_close_week, execute_contribute_to_pool,
    execute_draw_weekly_winner, execute_expire_week, execute_reclaim_ticket, execute_redeem,
    execute_sweep_expired_prize, execute_sweep_ustc, execute_withdraw_ticket, open_new_week,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, GlobalState, CONFIG, STATE};

// Bounds on the numeric `instantiate` fields that were previously accepted
// unchecked (2026-08-24 audit fix, mirroring the same bug class
// create-your-own-luck already closed in its own `instantiate`, and the
// matching fix in wheel-manager's `contract.rs`). Without these, a
// pathological value (most dangerously 0) in any of these fields can leave a
// week permanently stuck in `Open` with no way to close it.
const MIN_ROUND_DURATION_DAYS: u64 = 1;
const MAX_ROUND_DURATION_DAYS: u64 = 90;
const MIN_DRAW_DELAY_BLOCKS: u64 = 1;
const MAX_DRAW_DELAY_BLOCKS: u64 = 1_000_000;
const MIN_DRAW_WINDOW_BLOCKS: u64 = 1;
const MAX_DRAW_WINDOW_BLOCKS: u64 = 1_000_000;
const MIN_UNCLAIMED_DEADLINE_DAYS: u64 = 1;
const MAX_UNCLAIMED_DEADLINE_DAYS: u64 = 365;
/// Upper bound on `max_players` - see wheel-manager's matching constant's
/// doc comment for the full rationale (found by an independent second-
/// opinion review of this same fix). Same value, same reasoning.
const MAX_MAX_PLAYERS: u32 = 100;
/// Upper bound on `price_increment_per_day` (found by an independent
/// second-opinion review, 2026-08-24): unlike every other numeric
/// `instantiate` field, this one was left completely unbounded, including no
/// zero check on `base_ticket_price`'s multiplication partner. `today_price`
/// computes `base_ticket_price + price_increment_per_day * elapsed_days` in
/// `execute.rs` - with `overflow-checks = true` (this crate's release
/// profile), a pathological value here panics that arithmetic, and it's
/// called from 3 query handlers (`GetCurrentWeek`/`GetTodayPrice`/
/// `GetWeekHistory`) as well as `BuyWeeklyTicket` - a single bad deploy value
/// would panic every query against the contract, not just executes. Bounded
/// well above any real production value (1_000_000 = "1 USDC"/day) while
/// staying many orders of magnitude below where `u128` multiplication by any
/// realistic `elapsed_days` could overflow.
const MAX_PRICE_INCREMENT_PER_DAY: u128 = 1_000_000_000_000;
/// Upper bound on `base_ticket_price` (CodeRabbit finding on this same fix,
/// 2026-08-24): bounding `price_increment_per_day` alone isn't enough -
/// `base_ticket_price` near `Uint128::MAX` still overflows `today_price`'s
/// addition on day one even with a tiny, in-bounds increment. Same headroom
/// reasoning as `MAX_PRICE_INCREMENT_PER_DAY` above.
const MAX_BASE_TICKET_PRICE: u128 = 1_000_000_000_000;

/// Cosmos SDK's own denomination grammar (`ValidateDenom`): 3-128 chars,
/// first an ASCII letter, the rest ASCII letters/digits or one of `/:._-`.
/// A denom that fails this (found by the same CodeRabbit review, 2026-08-24)
/// passes a plain non-empty check but still makes every `BankMsg::Send`
/// using it fail validation at the bank module - the same brick this
/// contract's other instantiate bounds exist to prevent. No regex crate
/// needed for a grammar this simple.
fn is_valid_denom(denom: &str) -> bool {
    let bytes = denom.as_bytes();
    if bytes.len() < 3 || bytes.len() > 128 {
        return false;
    }
    if !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b':' | b'.' | b'_' | b'-'))
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.min_players < 2 || msg.max_players < msg.min_players {
        return Err(ContractError::InvalidPlayerBounds {});
    }
    if msg.max_players > MAX_MAX_PLAYERS {
        return Err(ContractError::MaxPlayersTooHigh { max: MAX_MAX_PLAYERS });
    }
    // A zero base ticket price would make ReclaimTicket/WithdrawTicket try to
    // send a zero-amount BankMsg::Send on day 0 (or forever, if
    // price_increment_per_day is also 0), which the Cosmos SDK rejects as
    // invalid coins - permanently bricking those refund paths.
    if msg.base_ticket_price.is_zero() {
        return Err(ContractError::TicketPriceCannotBeZero {});
    }
    if msg.base_ticket_price.u128() > MAX_BASE_TICKET_PRICE {
        return Err(ContractError::TicketPriceTooHigh { max: MAX_BASE_TICKET_PRICE });
    }
    if msg.price_increment_per_day.u128() > MAX_PRICE_INCREMENT_PER_DAY {
        return Err(ContractError::PriceIncrementTooHigh { max: MAX_PRICE_INCREMENT_PER_DAY });
    }
    // An invalid denom (empty, or one that fails the Cosmos SDK's own
    // ValidateDenom grammar) would make BankMsg::Send fail validation on
    // every refund/payout path, the same brick TicketPriceCannotBeZero
    // closes for the amount side. Deliberately NOT rejecting ticket_denom ==
    // redemption_denom here even though Redeem is economically degenerate in
    // that case (a winner's own payment round-trips back to them instead of
    // coming from the pool) - that's the project's own established,
    // deliberate testnet convention (both fields set to "uluna" in
    // deployWheelManager.ts, since testnet has no real USDC/USTC liquidity;
    // see the project's "testnet liquidity pattern" notes), not a
    // misconfiguration to guard against. Mainnet always uses genuinely
    // distinct denoms (uusd/the real USDC IBC denom).
    if !is_valid_denom(&msg.ticket_denom) || !is_valid_denom(&msg.redemption_denom) {
        return Err(ContractError::InvalidDenom {});
    }
    if msg.round_duration_days < MIN_ROUND_DURATION_DAYS || msg.round_duration_days > MAX_ROUND_DURATION_DAYS {
        return Err(ContractError::InvalidRoundDurationDays {
            min: MIN_ROUND_DURATION_DAYS,
            max: MAX_ROUND_DURATION_DAYS,
        });
    }
    if msg.draw_delay_blocks < MIN_DRAW_DELAY_BLOCKS || msg.draw_delay_blocks > MAX_DRAW_DELAY_BLOCKS {
        return Err(ContractError::InvalidDrawDelayBlocks {
            min: MIN_DRAW_DELAY_BLOCKS,
            max: MAX_DRAW_DELAY_BLOCKS,
        });
    }
    if msg.draw_window_blocks < MIN_DRAW_WINDOW_BLOCKS || msg.draw_window_blocks > MAX_DRAW_WINDOW_BLOCKS {
        return Err(ContractError::InvalidDrawWindowBlocks {
            min: MIN_DRAW_WINDOW_BLOCKS,
            max: MAX_DRAW_WINDOW_BLOCKS,
        });
    }
    if msg.unclaimed_deadline_days < MIN_UNCLAIMED_DEADLINE_DAYS
        || msg.unclaimed_deadline_days > MAX_UNCLAIMED_DEADLINE_DAYS
    {
        return Err(ContractError::InvalidUnclaimedDeadlineDays {
            min: MIN_UNCLAIMED_DEADLINE_DAYS,
            max: MAX_UNCLAIMED_DEADLINE_DAYS,
        });
    }

    let config = Config {
        admin: info.sender.clone(),
        base_ticket_price: msg.base_ticket_price,
        price_increment_per_day: msg.price_increment_per_day,
        ticket_denom: msg.ticket_denom,
        redemption_denom: msg.redemption_denom,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_duration_days: msg.round_duration_days,
        draw_delay_blocks: msg.draw_delay_blocks,
        draw_window_blocks: msg.draw_window_blocks,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        treasury_address: deps.api.addr_validate(&msg.treasury_address)?,
        admin_fee_address: deps.api.addr_validate(&msg.admin_fee_address)?,
    };
    CONFIG.save(deps.storage, &config)?;
    STATE.save(deps.storage, &GlobalState { current_week_id: 1 })?;
    open_new_week(deps.storage, &env, 1, Uint128::zero())?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("admin", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::ContributeToPool {
            source_wheel,
            source_round_id,
        } => execute_contribute_to_pool(deps, info, source_wheel, source_round_id),
        ExecuteMsg::BuyWeeklyTicket {} => execute_buy_weekly_ticket(deps, env, info),
        ExecuteMsg::CloseWeek {} => execute_close_week(deps, env),
        ExecuteMsg::DrawWeeklyWinner {} => execute_draw_weekly_winner(deps, env),
        ExecuteMsg::Redeem { week_id } => execute_redeem(deps, info, week_id),
        ExecuteMsg::SweepUstc {} => execute_sweep_ustc(deps, env, info),
        ExecuteMsg::SweepExpiredPrize { week_id } => execute_sweep_expired_prize(deps, env, week_id),
        ExecuteMsg::ExpireWeek {} => execute_expire_week(deps, env),
        ExecuteMsg::ReclaimTicket { week_id } => execute_reclaim_ticket(deps, info, week_id),
        ExecuteMsg::WithdrawTicket { week_id } => execute_withdraw_ticket(deps, info, week_id),
    }
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, env, msg)
}
