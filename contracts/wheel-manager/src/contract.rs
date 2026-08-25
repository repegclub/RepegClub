use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult, Uint128};

use crate::error::ContractError;
use crate::execute::{
    execute_buy_ticket, execute_close_round, execute_draw_winner, execute_expire_round,
    execute_reclaim_ticket, execute_redeem, execute_sweep_expired_prize, execute_sweep_ustc,
    execute_withdraw_ticket, open_new_round,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, GlobalState, CONFIG, STATE};

// Bounds on the numeric `instantiate` fields that were previously accepted
// unchecked (2026-08-24 audit fix, mirroring the same bug class
// create-your-own-luck already closed in its own `instantiate`). Without
// these, a pathological value (most dangerously 0) in any of these fields
// can leave a round permanently stuck in `Open` with no way to close it.
const MIN_ROUND_TIMEOUT_SECONDS: u64 = 60; // 1 minute
const MAX_ROUND_TIMEOUT_SECONDS: u64 = 604_800; // 7 days - this is the rolling soft-close increment (production: 3600s), not a fixed raffle length
const MIN_DRAW_DELAY_BLOCKS: u64 = 1;
const MAX_DRAW_DELAY_BLOCKS: u64 = 1_000_000;
const MIN_DRAW_WINDOW_BLOCKS: u64 = 1;
const MAX_DRAW_WINDOW_BLOCKS: u64 = 1_000_000;
const MIN_UNCLAIMED_DEADLINE_DAYS: u64 = 1;
const MAX_UNCLAIMED_DEADLINE_DAYS: u64 = 365;
const MIN_MAX_ROUND_AGE_SECONDS: u64 = 86_400; // 1 day
const MAX_MAX_ROUND_AGE_SECONDS: u64 = 2_678_400; // 31 days
/// Upper bound on `max_players`, same bug class as the timing fields above
/// (found by an independent second-opinion review of this same fix): without
/// it, `entrants` can grow unbounded (worst case `max_players * (max_players
/// / 2)`, from `max_tickets_per_wallet`), making `DrawWinner`'s winner-
/// picking scan and `execute_buy_ticket`'s per-wallet scan arbitrarily
/// expensive - a second review round confirmed every scan of `entrants` in
/// this contract is linear, not quadratic, and cosmwasm-vm's own ~128KiB
/// storage-value limit is the real practical backstop either way, but this
/// still keeps the worst case an order of magnitude below that limit instead
/// of relying on it. 10x headroom over the real production value (10),
/// matching create-your-own-luck's own cap on its equivalent field exactly
/// rather than picking a different number for no reason.
const MAX_MAX_PLAYERS: u32 = 100;
/// Upper bound on `ticket_price` (CodeRabbit finding on the matching
/// weekly-round check, 2026-08-24): `ticket_price` near `Uint128::MAX`
/// overflows `execute_reclaim_ticket`/`execute_withdraw_ticket`'s
/// `ticket_price * ticket_count` multiplication even with a `ticket_count`
/// bounded by `max_tickets_per_wallet`. Same headroom reasoning as
/// weekly-round's `MAX_BASE_TICKET_PRICE`.
const MAX_TICKET_PRICE: u128 = 1_000_000_000_000;

/// Cosmos SDK's own denomination grammar (`ValidateDenom`) - see
/// weekly-round's matching function for the full rationale.
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
    // A zero ticket price would make ReclaimTicket/WithdrawTicket try to send
    // a zero-amount BankMsg::Send, which the Cosmos SDK rejects as invalid
    // coins - permanently bricking those refund paths (same bug class again).
    if msg.ticket_price.is_zero() {
        return Err(ContractError::TicketPriceCannotBeZero {});
    }
    if msg.ticket_price.u128() > MAX_TICKET_PRICE {
        return Err(ContractError::TicketPriceTooHigh { max: MAX_TICKET_PRICE });
    }
    // An invalid denom (empty, or one that fails the Cosmos SDK's own
    // ValidateDenom grammar) would make BankMsg::Send fail validation on
    // every refund/payout path, the same brick TicketPriceCannotBeZero
    // closes for the amount side. Deliberately NOT rejecting ticket_denom ==
    // redemption_denom even though Redeem is economically degenerate in that
    // case (a winner's own payment round-trips back to them instead of
    // coming from the pool) - see weekly-round's matching check for why
    // that's this project's own established, deliberate testnet convention.
    if !is_valid_denom(&msg.ticket_denom) || !is_valid_denom(&msg.redemption_denom) {
        return Err(ContractError::InvalidDenom {});
    }
    if msg.round_timeout_seconds < MIN_ROUND_TIMEOUT_SECONDS
        || msg.round_timeout_seconds > MAX_ROUND_TIMEOUT_SECONDS
    {
        return Err(ContractError::InvalidRoundTimeoutSeconds {
            min: MIN_ROUND_TIMEOUT_SECONDS,
            max: MAX_ROUND_TIMEOUT_SECONDS,
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
    if msg.max_round_age_seconds < MIN_MAX_ROUND_AGE_SECONDS
        || msg.max_round_age_seconds > MAX_MAX_ROUND_AGE_SECONDS
    {
        return Err(ContractError::InvalidMaxRoundAgeSeconds {
            min: MIN_MAX_ROUND_AGE_SECONDS,
            max: MAX_MAX_ROUND_AGE_SECONDS,
        });
    }

    let config = Config {
        admin: info.sender.clone(),
        ticket_price: msg.ticket_price,
        ticket_denom: msg.ticket_denom,
        redemption_denom: msg.redemption_denom,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_timeout_seconds: msg.round_timeout_seconds,
        draw_delay_blocks: msg.draw_delay_blocks,
        draw_window_blocks: msg.draw_window_blocks,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        max_round_age_seconds: msg.max_round_age_seconds,
        treasury_address: deps.api.addr_validate(&msg.treasury_address)?,
        admin_fee_address: deps.api.addr_validate(&msg.admin_fee_address)?,
        weekly_round_address: deps.api.addr_validate(&msg.weekly_round_address)?,
    };
    CONFIG.save(deps.storage, &config)?;
    STATE.save(
        deps.storage,
        &GlobalState {
            current_round_id: 1,
            next_round_carry: Uint128::zero(),
        },
    )?;
    open_new_round(deps.storage, &env, 1, Uint128::zero())?;

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
        ExecuteMsg::BuyTicket {} => execute_buy_ticket(deps, env, info),
        ExecuteMsg::CloseRound {} => execute_close_round(deps, env),
        ExecuteMsg::DrawWinner {} => execute_draw_winner(deps, env),
        ExecuteMsg::Redeem { round_id } => execute_redeem(deps, info, round_id),
        ExecuteMsg::SweepUstc {} => execute_sweep_ustc(deps, env, info),
        ExecuteMsg::SweepExpiredPrize { round_id } => {
            execute_sweep_expired_prize(deps, env, round_id)
        }
        ExecuteMsg::ExpireRound {} => execute_expire_round(deps, env),
        ExecuteMsg::ReclaimTicket { round_id } => execute_reclaim_ticket(deps, info, round_id),
        ExecuteMsg::WithdrawTicket { round_id } => execute_withdraw_ticket(deps, info, round_id),
    }
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, msg)
}
