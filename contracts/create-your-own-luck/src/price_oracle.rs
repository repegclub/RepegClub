use cosmwasm_schema::cw_serde;
use cosmwasm_std::{QuerierWrapper, StdError, StdResult, Uint128};

use crate::state::Config;

#[cw_serde]
pub enum PoolQueryMsg {
    Pool {},
}

#[cw_serde]
pub struct AssetInfoNative {
    pub denom: String,
}

#[cw_serde]
pub struct AssetInfo {
    pub native_token: Option<AssetInfoNative>,
}

#[cw_serde]
pub struct Asset {
    pub info: AssetInfo,
    pub amount: Uint128,
}

#[cw_serde]
pub struct PoolResponse {
    pub assets: Vec<Asset>,
    pub total_share: Uint128,
}

fn find_reserve(pool: &PoolResponse, denom: &str) -> StdResult<Uint128> {
    pool.assets
        .iter()
        .find(|a| a.info.native_token.as_ref().map(|n| n.denom.as_str()) == Some(denom))
        .map(|a| a.amount)
        .ok_or_else(|| StdError::generic_err(format!("denom {denom} not found in DEX pool reserves")))
}

/// Quotes how much USTC currently equals `config.fee_reference_usd_micros`, via a
/// 2-hop route (USTC/LUNC then LUNC/USDC), both read-only `Pool {}` queries
/// against Terraport-fork pool contracts. See docs/rueda-del-repeg-diseno.html
/// §08 for why this route was chosen over a direct USTC/USDC pool.
pub fn quote_ustc_fee(querier: &QuerierWrapper, config: &Config) -> StdResult<Uint128> {
    let ustc_lunc_pool: PoolResponse = querier.query_wasm_smart(&config.ustc_lunc_pool, &PoolQueryMsg::Pool {})?;
    let lunc_usdc_pool: PoolResponse = querier.query_wasm_smart(&config.lunc_usdc_pool, &PoolQueryMsg::Pool {})?;

    let reserve_ustc = find_reserve(&ustc_lunc_pool, &config.ustc_denom)?;
    let reserve_lunc_a = find_reserve(&ustc_lunc_pool, &config.lunc_denom)?;
    let reserve_lunc_b = find_reserve(&lunc_usdc_pool, &config.lunc_denom)?;
    let reserve_usdc = find_reserve(&lunc_usdc_pool, &config.usdc_denom)?;

    let lunc_equivalent = config
        .fee_reference_usd_micros
        .multiply_ratio(reserve_lunc_b, reserve_usdc);
    let ustc_equivalent = lunc_equivalent.multiply_ratio(reserve_ustc, reserve_lunc_a);

    Ok(ustc_equivalent)
}
