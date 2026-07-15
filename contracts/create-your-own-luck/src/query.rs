use cosmwasm_std::{to_json_binary, Binary, Deps, Env, StdResult};

use crate::msg::{
    ConfigResponse, MyAirdropShareResponse, QueryMsg, RaffleStatusResponse, WinnersResponse,
};
use crate::state::{RaffleStatus, AIRDROP_CLAIMS, CONFIG, RAFFLE};

pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetRaffleStatus {} => to_json_binary(&query_raffle_status(deps, env)?),
        QueryMsg::GetWinners {} => to_json_binary(&query_winners(deps)?),
        QueryMsg::GetMyAirdropShare { wallet } => to_json_binary(&query_my_airdrop_share(deps, wallet)?),
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
    }
}

fn query_raffle_status(deps: Deps, env: Env) -> StdResult<RaffleStatusResponse> {
    let config = CONFIG.load(deps.storage)?;
    let raffle = RAFFLE.load(deps.storage)?;

    let seconds_remaining = match (raffle.status, raffle.opened_at) {
        (RaffleStatus::Open, Some(opened_at)) => {
            let deadline = opened_at.seconds() + config.round_timeout_seconds;
            Some(deadline.saturating_sub(env.block.time.seconds()))
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
        draw_after_height: raffle.draw_after_height,
    })
}

fn query_winners(deps: Deps) -> StdResult<WinnersResponse> {
    let raffle = RAFFLE.load(deps.storage)?;
    Ok(WinnersResponse {
        winners: raffle.winners,
        prize_shares: raffle.prize_shares,
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
        draw_delay_blocks: config.draw_delay_blocks,
        draw_window_blocks: config.draw_window_blocks,
        unclaimed_deadline_days: config.unclaimed_deadline_days,
        prize_asset: config.prize_asset,
        fee_amount_usdc: config.fee_amount_usdc,
        usdc_denom: config.usdc_denom,
        founder_fee_address: config.founder_fee_address,
        treasury_address: config.treasury_address,
        podium_shares_bps: config.podium_shares_bps,
    })
}
