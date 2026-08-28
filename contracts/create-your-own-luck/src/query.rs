use cosmwasm_std::{to_json_binary, Binary, Deps, Env, StdResult};

use crate::msg::{
    ConfigResponse, EntrantsResponse, MyAirdropShareResponse, QueryMsg, RaffleStatusResponse,
    WinnersResponse,
};
use crate::state::{RaffleStatus, AIRDROP_CLAIMS, CONFIG, RAFFLE};

pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetRaffleStatus {} => to_json_binary(&query_raffle_status(deps, env)?),
        QueryMsg::GetWinners {} => to_json_binary(&query_winners(deps)?),
        QueryMsg::GetMyAirdropShare { wallet } => to_json_binary(&query_my_airdrop_share(deps, wallet)?),
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
        QueryMsg::GetEntrants {} => to_json_binary(&query_entrants(deps)?),
    }
}

fn query_raffle_status(deps: Deps, env: Env) -> StdResult<RaffleStatusResponse> {
    let config = CONFIG.load(deps.storage)?;
    let raffle = RAFFLE.load(deps.storage)?;

    // `None` until `min_players` is first reached (see `RaffleState::
    // deadline`'s own doc comment) - there's no meaningful countdown before
    // that point under the soft-close design, unlike the old fixed-from-
    // opened_at timeout this replaces.
    let seconds_remaining = match (raffle.status, raffle.deadline) {
        (RaffleStatus::Open, Some(deadline)) => {
            Some(deadline.seconds().saturating_sub(env.block.time.seconds()))
        }
        _ => None,
    };

    Ok(RaffleStatusResponse {
        status: raffle.status,
        raffle_type: config.raffle_type,
        ticket_count: raffle.entrants.len() as u64,
        unique_player_count: raffle.unique_players.len() as u64,
        prize_amount: raffle.prize_amount,
        prize_asset: config.prize_asset,
        fee_paid: raffle.fee_paid,
        opened_at: raffle.opened_at.map(|t| t.seconds()),
        closed_at: raffle.closed_at.map(|t| t.seconds()),
        seconds_remaining,
        closed_at_height: raffle.closed_at_height,
        commit_used: raffle.commit_used,
        revealed_preimage: raffle.revealed_preimage,
    })
}

fn query_winners(deps: Deps) -> StdResult<WinnersResponse> {
    let raffle = RAFFLE.load(deps.storage)?;
    Ok(WinnersResponse {
        winners: raffle.winners,
        prize_shares: raffle.prize_shares,
        prize_paid: raffle.prize_paid,
    })
}

fn query_my_airdrop_share(deps: Deps, wallet: String) -> StdResult<MyAirdropShareResponse> {
    let addr = deps.api.addr_validate(&wallet)?;
    let raffle = RAFFLE.load(deps.storage)?;
    let claimed = AIRDROP_CLAIMS.may_load(deps.storage, addr.clone())?.unwrap_or(false);
    let share = if raffle.unique_players.contains(&addr) {
        raffle.airdrop_share
    } else {
        cosmwasm_std::Uint128::zero()
    };
    Ok(MyAirdropShareResponse { share, claimed })
}

fn query_entrants(deps: Deps) -> StdResult<EntrantsResponse> {
    let raffle = RAFFLE.load(deps.storage)?;
    Ok(EntrantsResponse {
        entrants: raffle.entrants,
    })
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        creator: config.creator,
        raffle_type: config.raffle_type,
        ticket_price: config.ticket_price,
        ticket_denom: config.ticket_denom,
        allowed_entrants: config.allowed_entrants,
        min_players: config.min_players,
        max_players: config.max_players,
        round_timeout_seconds: config.round_timeout_seconds,
        unclaimed_deadline_days: config.unclaimed_deadline_days,
        prize_asset: config.prize_asset,
        fee_amount_usdc: config.fee_amount_usdc,
        usdc_denom: config.usdc_denom,
        founder_fee_address: config.founder_fee_address,
        treasury_address: config.treasury_address,
        factory_address: config.factory_address,
        podium_shares_bps: config.podium_shares_bps,
        cancellation_penalty_base_bps: config.cancellation_penalty_base_bps,
        cancellation_penalty_late_additional_bps: config.cancellation_penalty_late_additional_bps,
    })
}
