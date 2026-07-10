use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult, Uint128};

use crate::error::ContractError;
use crate::execute::{
    execute_buy_ticket, execute_close_round, execute_draw_winner, execute_redeem,
    execute_sweep_expired_prize, execute_sweep_ustc, open_new_round,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, GlobalState, CONFIG, STATE};

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

    let config = Config {
        admin: info.sender.clone(),
        ticket_price: msg.ticket_price,
        ticket_denom: msg.ticket_denom,
        redemption_denom: msg.redemption_denom,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_timeout_seconds: msg.round_timeout_seconds,
        draw_delay_blocks: msg.draw_delay_blocks,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
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
    }
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, msg)
}
