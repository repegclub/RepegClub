use cosmwasm_schema::cw_serde;
use cosmwasm_std::{to_json_binary, DepsMut, Env, MessageInfo, Response, SubMsg, Uint128, WasmMsg};

use crate::error::ContractError;
use crate::msg::RaffleType;
use crate::state::{CreatorCooldown, CREATOR_COOLDOWNS, PENDING_CREATOR, RAFFLE_CODE_ID, RAFFLE_COUNT};

pub const CREATE_RAFFLE_REPLY_ID: u64 = 1;

/// Below this `max_players`, a paid SingleWinner/Podium raffle's service fee
/// (scales roughly with `max_players^2` in create-your-own-luck's own
/// `contract.rs`) is cheap enough that a dishonest creator could profitably
/// repeat the same small raffle many times to scale up self-dealing gains -
/// no single repeat is worth much, but the fee barely costs anything either,
/// so volume is the actual attack (see the project's CYOL security notes,
/// 2026-07-22). Airdrop is excluded (no winner to "steal" the prize from,
/// already capped at 1 ticket/wallet) and free raffles are excluded (the
/// creator extracts nothing from third parties that way - see
/// create-your-own-luck's own prize-whitelist reasoning for the same
/// free-vs-paid split).
const UNSAFE_MAX_PLAYERS_THRESHOLD: u32 = 20;

/// Growing cooldown step: the Nth unsafe-shaped raffle in a row from the same
/// creator locks out their *next* unsafe-shaped raffle for N times this many
/// hours - 24h, 48h, 72h, ... This taxes repeating the cheap-exploit shape
/// specifically, without touching a creator who only occasionally makes one
/// small paid raffle, or who makes any number of safe-shaped ones.
const UNSAFE_COOLDOWN_STEP_HOURS: u64 = 24;

/// Ceiling on the streak counted toward the cooldown - not a limit on how
/// many unsafe raffles a creator can eventually make (they can, just slower
/// each time), but a bound on the arithmetic (`streak * step_hours * 3600`
/// feeding `Timestamp::plus_seconds`) so a creator repeating this for a very
/// long time can't approach an overflow. 30 -> a 30-day cooldown ceiling, a
/// human-scale maximum, same reasoning as create-your-own-luck's own
/// duration bounds (`MAX_UNCLAIMED_DEADLINE_DAYS` etc.).
const MAX_UNSAFE_STREAK: u32 = 30;

/// If a creator's last cooldown ended this many days ago (or longer) without
/// them attempting another unsafe-shaped raffle since, their streak starts
/// over at the next attempt instead of continuing to climb - an ungameable,
/// purely time-based "cooled off" forgiveness, since it only depends on real
/// wall-clock time passing, not on any action a creator can take for free.
const UNSAFE_STREAK_STALE_AFTER_DAYS: u64 = 30;

/// Mirrors create-your-own-luck's `InstantiateMsg` exactly (field names and
/// shape, not the type - see `msg::RaffleType` for why it's duplicated) so
/// this serializes to the JSON that contract's own `instantiate` expects.
#[cw_serde]
struct RaffleInstantiateMsg {
    raffle_type: RaffleType,
    ticket_price: Uint128,
    ticket_denom: String,
    allowed_entrants: Option<Vec<String>>,
    min_players: u32,
    max_players: u32,
    round_timeout_seconds: u64,
    draw_delay_blocks: u64,
    draw_window_blocks: u64,
    unclaimed_deadline_days: u64,
    max_raffle_age_seconds: u64,
    prize_native_denom: Option<String>,
    prize_cw20_address: Option<String>,
    podium_shares_bps: Vec<u32>,
}

#[allow(clippy::too_many_arguments)]
pub fn execute_create_raffle(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    raffle_type: RaffleType,
    ticket_price: Uint128,
    ticket_denom: String,
    allowed_entrants: Option<Vec<String>>,
    min_players: u32,
    max_players: u32,
    round_timeout_seconds: u64,
    draw_delay_blocks: u64,
    draw_window_blocks: u64,
    unclaimed_deadline_days: u64,
    max_raffle_age_seconds: u64,
    prize_native_denom: Option<String>,
    prize_cw20_address: Option<String>,
    podium_shares_bps: Vec<u32>,
) -> Result<Response, ContractError> {
    // The raffle itself takes no funds at instantiate time either (the
    // creator funds it separately once its address is known) - forwarding
    // stray funds here would strand them, since this contract has no sweep
    // mechanism for anything but the one thing it's meant to hold (nothing).
    if !info.funds.is_empty() {
        return Err(ContractError::UnexpectedFundsAttached {});
    }

    let is_unsafe_shape =
        raffle_type != RaffleType::Airdrop && !ticket_price.is_zero() && max_players < UNSAFE_MAX_PLAYERS_THRESHOLD;
    if is_unsafe_shape {
        let existing_cooldown = CREATOR_COOLDOWNS.may_load(deps.storage, info.sender.clone())?;
        if let Some(cooldown) = &existing_cooldown {
            if env.block.time < cooldown.next_unsafe_allowed_at {
                return Err(ContractError::CreatorOnCooldown {
                    available_at: cooldown.next_unsafe_allowed_at.seconds(),
                });
            }
        }
        // Time-based decay only, never triggerable by any action a creator
        // can take for free (found by a CodeRabbit review, 2026-07-22: an
        // earlier version reset the streak on any safe-shaped raffle, which
        // costs nothing and needs no funding/players - a creator could wipe
        // an active cooldown outright with a single throwaway safe raffle,
        // fully defeating this cooldown). A stale streak (no unsafe attempt
        // in a long time) starts over; otherwise it keeps climbing from
        // wherever it left off, regardless of what else was created since.
        let stale = existing_cooldown.as_ref().is_none_or(|c| {
            env.block.time.seconds() >= c.next_unsafe_allowed_at.seconds() + UNSAFE_STREAK_STALE_AFTER_DAYS * 86400
        });
        let base_streak = if stale {
            0
        } else {
            existing_cooldown.as_ref().map(|c| c.unsafe_streak).unwrap_or(0)
        };
        let new_streak = base_streak.saturating_add(1).min(MAX_UNSAFE_STREAK);
        let cooldown_seconds = UNSAFE_COOLDOWN_STEP_HOURS
            .saturating_mul(new_streak as u64)
            .saturating_mul(3600);
        CREATOR_COOLDOWNS.save(
            deps.storage,
            info.sender.clone(),
            &CreatorCooldown {
                unsafe_streak: new_streak,
                next_unsafe_allowed_at: env.block.time.plus_seconds(cooldown_seconds),
            },
        )?;
    }
    // A safe-shaped raffle (free, or max_players >= threshold) never touches
    // CREATOR_COOLDOWNS at all - it's always allowed, and deliberately has no
    // side effect on an existing cooldown, active or not (see above).

    let raffle_code_id = RAFFLE_CODE_ID.load(deps.storage)?;
    let index = RAFFLE_COUNT.load(deps.storage)?;

    let instantiate_msg = RaffleInstantiateMsg {
        raffle_type,
        ticket_price,
        ticket_denom,
        allowed_entrants,
        min_players,
        max_players,
        round_timeout_seconds,
        draw_delay_blocks,
        draw_window_blocks,
        unclaimed_deadline_days,
        max_raffle_age_seconds,
        prize_native_denom,
        prize_cw20_address,
        podium_shares_bps,
    };

    PENDING_CREATOR.save(deps.storage, &info.sender)?;

    let wasm_msg = WasmMsg::Instantiate {
        admin: None,
        code_id: raffle_code_id,
        msg: to_json_binary(&instantiate_msg)?,
        funds: vec![],
        label: format!("repeg-club-raffle-{index}"),
    };

    let sub_msg = SubMsg::reply_on_success(wasm_msg, CREATE_RAFFLE_REPLY_ID);

    Ok(Response::new()
        .add_submessage(sub_msg)
        .add_attribute("action", "create_raffle")
        .add_attribute("creator", info.sender))
}
