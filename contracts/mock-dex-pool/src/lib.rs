// TEST STUB ONLY - mimics a Terraswap-fork pool contract's `Pool {}` query
// with fixed reserves set at instantiation, so Create Your Own Luck's
// `quote_ustc_fee` can be exercised against a real deployed contract on
// testnet (the real USTC/LUNC and LUNC/USDC pools only exist on mainnet).

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{entry_point, to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult, Uint128};
use cw_storage_plus::Item;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, schemars::JsonSchema)]
pub struct AssetInfoNative {
    pub denom: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, schemars::JsonSchema)]
pub struct AssetInfo {
    pub native_token: AssetInfoNative,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, schemars::JsonSchema)]
pub struct Asset {
    pub info: AssetInfo,
    pub amount: Uint128,
}

const ASSETS: Item<Vec<Asset>> = Item::new("assets");

#[cw_serde]
pub struct InstantiateMsg {
    pub reserves: Vec<(String, Uint128)>,
}

#[cw_serde]
pub enum ExecuteMsg {}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(PoolResponse)]
    Pool {},
}

#[cw_serde]
pub struct PoolResponse {
    pub assets: Vec<Asset>,
    pub total_share: Uint128,
}

#[entry_point]
pub fn instantiate(deps: DepsMut, _env: Env, _info: MessageInfo, msg: InstantiateMsg) -> StdResult<Response> {
    let assets: Vec<Asset> = msg
        .reserves
        .into_iter()
        .map(|(denom, amount)| Asset {
            info: AssetInfo { native_token: AssetInfoNative { denom } },
            amount,
        })
        .collect();
    ASSETS.save(deps.storage, &assets)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(_deps: DepsMut, _env: Env, _info: MessageInfo, _msg: ExecuteMsg) -> StdResult<Response> {
    Ok(Response::new())
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Pool {} => to_json_binary(&PoolResponse {
            assets: ASSETS.load(deps.storage)?,
            total_share: Uint128::zero(),
        }),
    }
}
