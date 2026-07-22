use cosmwasm_std::{to_json_binary, Binary, Deps, Order, StdResult};
use cw_storage_plus::Bound;

use crate::msg::{ConfigResponse, CreatorCooldownResponse, QueryMsg, RaffleRecordResponse, RafflesResponse};
use crate::state::{CREATOR_COOLDOWNS, RAFFLES, RAFFLE_CODE_ID, RAFFLE_COUNT};

pub fn query(deps: Deps, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetRaffles { start_after, limit } => {
            to_json_binary(&query_raffles(deps, start_after, limit)?)
        }
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
        QueryMsg::GetCreatorCooldown { creator } => {
            to_json_binary(&query_creator_cooldown(deps, creator)?)
        }
    }
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
