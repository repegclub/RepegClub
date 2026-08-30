use cosmwasm_std::{to_json_binary, Binary, Deps, Order, StdResult};
use cw_storage_plus::Bound;

use crate::msg::{
    CancellationPenaltyResponse, ConfigResponse, CreatorCooldownResponse, QueryMsg, RaffleRecordResponse,
    RafflesResponse,
};
use crate::state::{
    ADMIN, CANCELLATION_PENALTY_BASE_BPS, CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS, COMMIT_PUSHER,
    CREATOR_COOLDOWNS, CW20_BLACKLIST, CW20_WHITELIST, RAFFLES, RAFFLE_CODE_ID, RAFFLE_COUNT,
};

pub fn query(deps: Deps, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetRaffles { start_after, limit } => {
            to_json_binary(&query_raffles(deps, start_after, limit)?)
        }
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
        QueryMsg::GetCreatorCooldown { creator } => {
            to_json_binary(&query_creator_cooldown(deps, creator)?)
        }
        QueryMsg::IsCw20Whitelisted { address } => {
            to_json_binary(&query_is_cw20_whitelisted(deps, address)?)
        }
        QueryMsg::IsCw20Blacklisted { address } => {
            to_json_binary(&query_is_cw20_blacklisted(deps, address)?)
        }
        QueryMsg::GetCancellationPenaltyBps {} => to_json_binary(&query_cancellation_penalty_bps(deps)?),
    }
}

fn query_is_cw20_whitelisted(deps: Deps, address: String) -> StdResult<bool> {
    let addr = deps.api.addr_validate(&address)?;
    Ok(CW20_WHITELIST.has(deps.storage, &addr))
}

fn query_is_cw20_blacklisted(deps: Deps, address: String) -> StdResult<bool> {
    let addr = deps.api.addr_validate(&address)?;
    Ok(CW20_BLACKLIST.has(deps.storage, &addr))
}

fn query_cancellation_penalty_bps(deps: Deps) -> StdResult<CancellationPenaltyResponse> {
    Ok(CancellationPenaltyResponse {
        base_bps: CANCELLATION_PENALTY_BASE_BPS.load(deps.storage)?,
        late_additional_bps: CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS.load(deps.storage)?,
    })
}

fn query_raffles(
    deps: Deps,
    start_after: Option<u64>,
    limit: Option<u32>,
) -> StdResult<RafflesResponse> {
    let limit = limit.unwrap_or(20).min(100) as usize;
    let total_count = RAFFLE_COUNT.load(deps.storage)?;

    let max_bound = start_after.map(Bound::exclusive);
    let raffles = RAFFLES
        .range(deps.storage, None, max_bound, Order::Descending)
        .take(limit)
        .map(|item| {
            let (index, record) = item?;
            Ok(RaffleRecordResponse {
                index,
                address: record.address,
                creator: record.creator,
                created_at: record.created_at.seconds(),
            })
        })
        .collect::<StdResult<Vec<_>>>()?;

    Ok(RafflesResponse {
        raffles,
        total_count,
    })
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    Ok(ConfigResponse {
        raffle_code_id: RAFFLE_CODE_ID.load(deps.storage)?,
        admin: ADMIN.load(deps.storage)?,
        commit_pusher: COMMIT_PUSHER.load(deps.storage)?,
    })
}

fn query_creator_cooldown(deps: Deps, creator: String) -> StdResult<CreatorCooldownResponse> {
    let addr = deps.api.addr_validate(&creator)?;
    let cooldown = CREATOR_COOLDOWNS.may_load(deps.storage, addr)?;
    Ok(CreatorCooldownResponse {
        unsafe_streak: cooldown.as_ref().map(|c| c.unsafe_streak).unwrap_or(0),
        next_unsafe_allowed_at: cooldown.map(|c| c.next_unsafe_allowed_at.seconds()),
    })
}
