use cosmwasm_std::{
    entry_point, BankMsg, Coin, Deps, DepsMut, Env, MessageInfo, Response, StdResult, Uint128,
};

use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg, StateResponse};
use crate::state::{State, STATE};

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    let state = State {
        admin: info.sender.clone(),
        ticket_denom: msg.ticket_denom,
        pool: 0,
        winner: None,
        redeemed: false,
    };
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("admin", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::BuyTicket {} => execute_buy_ticket(deps, info),
        ExecuteMsg::SetWinner { winner } => execute_set_winner(deps, info, winner),
        ExecuteMsg::Redeem {} => execute_redeem(deps, info),
    }
}

fn execute_buy_ticket(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let mut state = STATE.load(deps.storage)?;

    let sent: &Coin = info
        .funds
        .iter()
        .find(|c| c.denom == state.ticket_denom)
        .ok_or(ContractError::NoFundsSent {})?;

    if sent.amount.is_zero() {
        return Err(ContractError::NoFundsSent {});
    }

    state.pool += sent.amount.u128();
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "buy_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("amount", sent.amount.to_string())
        .add_attribute("pool", state.pool.to_string()))
}

fn execute_set_winner(
    deps: DepsMut,
    info: MessageInfo,
    winner: String,
) -> Result<Response, ContractError> {
    let mut state = STATE.load(deps.storage)?;

    if info.sender != state.admin {
        return Err(ContractError::Unauthorized {});
    }
    if state.winner.is_some() {
        return Err(ContractError::WinnerAlreadySet {});
    }

    let winner_addr = deps.api.addr_validate(&winner)?;
    state.winner = Some(winner_addr.clone());
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "set_winner")
        .add_attribute("winner", winner_addr))
}

fn execute_redeem(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let mut state = STATE.load(deps.storage)?;

    let winner = state.winner.clone().ok_or(ContractError::WinnerNotSet {})?;
    if info.sender != winner {
        return Err(ContractError::Unauthorized {});
    }
    if state.redeemed {
        return Err(ContractError::AlreadyRedeemed {});
    }

    let payout = Coin {
        denom: state.ticket_denom.clone(),
        amount: Uint128::from(state.pool),
    };

    state.redeemed = true;
    STATE.save(deps.storage, &state)?;

    let send_msg = BankMsg::Send {
        to_address: winner.to_string(),
        amount: vec![payout.clone()],
    };

    Ok(Response::new()
        .add_message(send_msg)
        .add_attribute("action", "redeem")
        .add_attribute("winner", winner)
        .add_attribute("amount", payout.amount.to_string()))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<cosmwasm_std::Binary> {
    match msg {
        QueryMsg::State {} => cosmwasm_std::to_json_binary(&query_state(deps)?),
    }
}

fn query_state(deps: Deps) -> StdResult<StateResponse> {
    let state = STATE.load(deps.storage)?;
    Ok(StateResponse {
        admin: state.admin,
        ticket_denom: state.ticket_denom,
        pool: state.pool,
        winner: state.winner,
        redeemed: state.redeemed,
    })
}
