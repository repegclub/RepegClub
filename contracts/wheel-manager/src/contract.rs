use cosmwasm_std::{
    entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Reply, Response, StdResult,
};

use crate::error::ContractError;
use crate::execute::{
    claim_expired_round, execute_assign_commit, execute_buy_ticket, execute_close_round,
    execute_discard_queued_commits, execute_expire_round, execute_finalize_expire_closed_round,
    execute_push_commits, execute_reclaim_ticket, execute_redeem,
    execute_request_expire_closed_round, execute_reveal_draw, execute_set_commit_pusher,
    execute_sweep_expired_prize, execute_sweep_ustc, execute_withdraw_ticket, open_new_round,
    reply as reply_impl,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, GlobalState, CONFIG, STATE};

/// Floor for `max_reveal_age_seconds`: well above realistic keeper latency
/// (the keeper reveals within a couple of blocks in normal operation) plus a
/// safety margin - a value too close to zero would make
/// `RequestExpireClosedRound` callable in ordinary operation, reopening the
/// cheap/instant version of the mempool front-run risk described in the
/// project's Obsidian notes ("Grinding vía SubMsg+reply", Ronda 9 finding).
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
    // Round-review fix (Opus, commit_pusher audit round, 2026-08-30): nothing
    // used to stop a deploy from passing the same address for both roles,
    // silently collapsing the separation this project added specifically so
    // a compromised commit_pusher key can't also do what admin can.
    if msg.commit_pusher == info.sender.as_str() {
        return Err(ContractError::CommitPusherMustDifferFromAdmin {});
    }

    let config = Config {
        admin: info.sender.clone(),
        ticket_price: msg.ticket_price,
        ticket_denom: msg.ticket_denom,
        redemption_denom: msg.redemption_denom,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_timeout_seconds: msg.round_timeout_seconds,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        max_round_age_seconds: msg.max_round_age_seconds,
        max_reveal_age_seconds: msg.max_reveal_age_seconds,
        treasury_address: deps.api.addr_validate(&msg.treasury_address)?,
        admin_fee_address: deps.api.addr_validate(&msg.admin_fee_address)?,
        weekly_round_address: deps.api.addr_validate(&msg.weekly_round_address)?,
        commit_pusher: deps.api.addr_validate(&msg.commit_pusher)?,
    };
    CONFIG.save(deps.storage, &config)?;
    STATE.save(
        deps.storage,
        &GlobalState {
            current_round_id: 1,
            next_round_carry: cosmwasm_std::Uint128::zero(),
        },
    )?;
    open_new_round(deps.storage, &env, 1)?;

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
        ExecuteMsg::RevealDraw { round_id, preimage } => {
            execute_reveal_draw(deps, env, info, round_id, preimage)
        }
        ExecuteMsg::Redeem { round_id } => execute_redeem(deps, info, round_id),
        ExecuteMsg::SweepUstc {} => execute_sweep_ustc(deps, env, info),
        ExecuteMsg::SweepExpiredPrize { round_id } => {
            execute_sweep_expired_prize(deps, env, round_id)
        }
        ExecuteMsg::ExpireRound {} => execute_expire_round(deps, env),
        ExecuteMsg::ReclaimTicket { round_id } => execute_reclaim_ticket(deps, info, round_id),
        ExecuteMsg::WithdrawTicket { round_id } => execute_withdraw_ticket(deps, info, round_id),
        ExecuteMsg::PushCommits { commits } => execute_push_commits(deps, info, commits),
        ExecuteMsg::AssignCommit {} => execute_assign_commit(deps, info),
        ExecuteMsg::RequestExpireClosedRound { round_id } => {
            execute_request_expire_closed_round(deps, env, info, round_id)
        }
        ExecuteMsg::FinalizeExpireClosedRound { round_id } => {
            execute_finalize_expire_closed_round(deps, env, info, round_id)
        }
        ExecuteMsg::ClaimExpiredRound { round_id } => claim_expired_round(deps, env, info, round_id),
        ExecuteMsg::DiscardQueuedCommits {} => execute_discard_queued_commits(deps, info),
        ExecuteMsg::SetCommitPusher { commit_pusher } => {
            execute_set_commit_pusher(deps, info, commit_pusher)
        }
    }
}

#[entry_point]
pub fn reply(deps: DepsMut, _env: Env, msg: Reply) -> Result<Response, ContractError> {
    reply_impl(deps, msg)
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, msg)
}
