// TEST STUB ONLY - not the real Weekly Round contract (that's a later stage of
// the project). This exists purely so Wheel Manager's `ContributeToPool`
// cross-contract call has a valid target to test against on testnet.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Response,
    StdResult, Uint128,
};
use cw_storage_plus::Item;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, schemars::JsonSchema)]
pub struct Contribution {
    pub source_wheel: String,
    pub source_round_id: u64,
    pub amount: Uint128,
    pub denom: String,
}

const TOTAL: Item<Uint128> = Item::new("total");
const CONTRIBUTIONS: Item<Vec<Contribution>> = Item::new("contributions");

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    ContributeToPool {
        source_wheel: String,
        source_round_id: u64,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(TotalResponse)]
    GetTotal {},
}

#[cw_serde]
pub struct TotalResponse {
    pub total: Uint128,
    pub contributions: Vec<Contribution>,
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> StdResult<Response> {
    TOTAL.save(deps.storage, &Uint128::zero())?;
    CONTRIBUTIONS.save(deps.storage, &vec![])?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(deps: DepsMut, _env: Env, info: MessageInfo, msg: ExecuteMsg) -> StdResult<Response> {
    match msg {
        ExecuteMsg::ContributeToPool {
            source_wheel,
            source_round_id,
        } => {
            let sent: &Coin = info
                .funds
                .first()
                .ok_or_else(|| cosmwasm_std::StdError::generic_err("no funds sent"))?;

            let mut total = TOTAL.load(deps.storage)?;
            total += sent.amount;
            TOTAL.save(deps.storage, &total)?;

            let mut contributions = CONTRIBUTIONS.load(deps.storage)?;
            contributions.push(Contribution {
                source_wheel,
                source_round_id,
                amount: sent.amount,
                denom: sent.denom.clone(),
            });
            CONTRIBUTIONS.save(deps.storage, &contributions)?;

            Ok(Response::new()
                .add_attribute("action", "contribute_to_pool")
                .add_attribute("sender", info.sender)
                .add_attribute("amount", sent.amount.to_string()))
        }
    }
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetTotal {} => to_json_binary(&TotalResponse {
            total: TOTAL.load(deps.storage)?,
            contributions: CONTRIBUTIONS.load(deps.storage)?,
        }),
    }
}
