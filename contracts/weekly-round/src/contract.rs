use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult};

use crate::error::ContractError;
use crate::execute::{
    claim_expired_week, execute_assign_commit, execute_buy_weekly_ticket, execute_close_week,
    execute_contribute_to_pool, execute_expire_week, execute_finalize_expire_closed_week,
    execute_push_commits, execute_reclaim_ticket, execute_redeem,
    execute_request_expire_closed_week, execute_reveal_draw, execute_sweep_expired_prize,
    execute_sweep_ustc, execute_withdraw_ticket, open_new_week,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, GlobalState, CONFIG, STATE};

/// See wheel-manager's matching constants' doc comments - same rationale.
pub const MIN_MAX_REVEAL_AGE_SECONDS: u64 = 1800; // 30 min
pub const MAX_MAX_REVEAL_AGE_SECONDS: u64 = 604_800; // 7 days

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
    if msg.max_reveal_age_seconds < MIN_MAX_REVEAL_AGE_SECONDS
        || msg.max_reveal_age_seconds > MAX_MAX_REVEAL_AGE_SECONDS
    {
        return Err(ContractError::InvalidMaxRevealAgeSeconds {
            min: MIN_MAX_REVEAL_AGE_SECONDS,
            max: MAX_MAX_REVEAL_AGE_SECONDS,
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
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        max_reveal_age_seconds: msg.max_reveal_age_seconds,
        treasury_address: deps.api.addr_validate(&msg.treasury_address)?,
        admin_fee_address: deps.api.addr_validate(&msg.admin_fee_address)?,
        commit_pusher: deps.api.addr_validate(&msg.commit_pusher)?,
    };
    CONFIG.save(deps.storage, &config)?;
    STATE.save(deps.storage, &GlobalState { current_week_id: 1 })?;
    open_new_week(deps.storage, &env, 1)?;

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
        ExecuteMsg::RevealDraw { week_id, preimage } => execute_reveal_draw(deps, env, info, week_id, preimage),
        ExecuteMsg::Redeem { week_id } => execute_redeem(deps, info, week_id),
        ExecuteMsg::SweepUstc {} => execute_sweep_ustc(deps, env, info),
        ExecuteMsg::SweepExpiredPrize { week_id } => execute_sweep_expired_prize(deps, env, week_id),
        ExecuteMsg::ExpireWeek {} => execute_expire_week(deps, env),
        ExecuteMsg::ReclaimTicket { week_id } => execute_reclaim_ticket(deps, info, week_id),
        ExecuteMsg::WithdrawTicket { week_id } => execute_withdraw_ticket(deps, info, week_id),
        ExecuteMsg::PushCommits { commits } => execute_push_commits(deps, info, commits),
        ExecuteMsg::AssignCommit {} => execute_assign_commit(deps),
        ExecuteMsg::RequestExpireClosedWeek { week_id } => {
            execute_request_expire_closed_week(deps, env, info, week_id)
        }
        ExecuteMsg::FinalizeExpireClosedWeek { week_id } => {
            execute_finalize_expire_closed_week(deps, env, info, week_id)
        }
        ExecuteMsg::ClaimExpiredWeek { week_id } => claim_expired_week(deps, env, info, week_id),
    }
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, env, msg)
}
