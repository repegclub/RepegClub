use cosmwasm_std::{
    entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Uint128,
};

use crate::error::ContractError;
use crate::execute::{
    execute_buy_ticket, execute_cancel_raffle, execute_claim_airdrop_share, execute_close_round,
    execute_deposit_prize, execute_draw_winner, execute_pay_service_fee, execute_reclaim_unclaimed,
    execute_receive,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, PrizeAsset, RaffleState, RaffleStatus, RaffleType, CONFIG, RAFFLE};

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.min_players < 2 || msg.max_players < msg.min_players {
        return Err(ContractError::InvalidPlayerBounds {});
    }
    if msg.raffle_type == RaffleType::Podium && msg.min_players < 3 {
        return Err(ContractError::PodiumNeedsThreePlayers {});
    }

    let prize_asset = match (msg.prize_native_denom, msg.prize_cw20_address) {
        (Some(denom), None) => PrizeAsset::Native { denom },
        (None, Some(addr)) => PrizeAsset::Cw20 {
            address: deps.api.addr_validate(&addr)?,
        },
        _ => {
            return Err(ContractError::Std(StdError::generic_err(
                "exactly one of prize_native_denom or prize_cw20_address must be set",
            )))
        }
    };

    let allowed_entrants = msg
        .allowed_entrants
        .map(|list| {
            list.iter()
                .map(|a| deps.api.addr_validate(a))
                .collect::<StdResult<Vec<_>>>()
        })
        .transpose()?;

    let config = Config {
        creator: info.sender.clone(),
        raffle_type: msg.raffle_type,
        ticket_price: msg.ticket_price,
        ticket_denom: msg.ticket_denom,
        allowed_entrants,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_timeout_seconds: msg.round_timeout_seconds,
        draw_delay_blocks: msg.draw_delay_blocks,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        prize_asset,
        fee_reference_usd_micros: msg.fee_reference_usd_micros,
        ustc_denom: msg.ustc_denom,
        lunc_denom: msg.lunc_denom,
        usdc_denom: msg.usdc_denom,
        ustc_lunc_pool: deps.api.addr_validate(&msg.ustc_lunc_pool)?,
        lunc_usdc_pool: deps.api.addr_validate(&msg.lunc_usdc_pool)?,
        founder_fee_address: deps.api.addr_validate(&msg.founder_fee_address)?,
        treasury_address: deps.api.addr_validate(&msg.treasury_address)?,
        burn_address: deps.api.addr_validate(&msg.burn_address)?,
    };
    CONFIG.save(deps.storage, &config)?;

    RAFFLE.save(
        deps.storage,
        &RaffleState {
            status: RaffleStatus::Funding,
            entrants: vec![],
            unique_players: vec![],
            ticket_revenue: Uint128::zero(),
            prize_amount: Uint128::zero(),
            fee_amount: Uint128::zero(),
            fee_paid: false,
            opened_at: None,
            closed_at: None,
            draw_after_height: None,
            drawn_at: None,
            winners: vec![],
            prize_shares: vec![],
            airdrop_share: Uint128::zero(),
            reclaimed: false,
        },
    )?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("creator", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::DepositPrize {} => execute_deposit_prize(deps, env, info),
        ExecuteMsg::PayServiceFee {} => execute_pay_service_fee(deps, info),
        ExecuteMsg::Receive(wrapper) => execute_receive(deps, env, info, wrapper),
        ExecuteMsg::BuyTicket {} => execute_buy_ticket(deps, env, info),
        ExecuteMsg::CloseRound {} => execute_close_round(deps, env),
        ExecuteMsg::DrawWinner {} => execute_draw_winner(deps, env),
        ExecuteMsg::ClaimAirdropShare {} => execute_claim_airdrop_share(deps, info),
        ExecuteMsg::ReclaimUnclaimed {} => execute_reclaim_unclaimed(deps, env, info),
        ExecuteMsg::CancelRaffle {} => execute_cancel_raffle(deps, info),
    }
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, env, msg)
}
