use cosmwasm_schema::cw_serde;
use cosmwasm_std::{to_json_binary, DepsMut, Env, MessageInfo, Response, SubMsg, Uint128, WasmMsg};

use crate::error::ContractError;
use crate::msg::RaffleType;
use crate::state::{PENDING_CREATOR, RAFFLE_CODE_ID, RAFFLE_COUNT};

pub const CREATE_RAFFLE_REPLY_ID: u64 = 1;

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
    prize_native_denom: Option<String>,
    prize_cw20_address: Option<String>,
    podium_shares_bps: Vec<u32>,
}

#[allow(clippy::too_many_arguments)]
pub fn execute_create_raffle(
    deps: DepsMut,
    _env: Env,
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
