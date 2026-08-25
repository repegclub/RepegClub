use cosmwasm_std::{to_json_binary, Binary, Deps, StdResult};

use crate::msg::{
    ConfigResponse, EntrantsResponse, MyWinningsResponse, QueryMsg, RoundResponse,
    WalletStatsResponse, WinningEntry,
};
use crate::state::{Round, CONFIG, ROUNDS, STATE, TOTAL_INVESTED, TOTAL_REDEEMED, WINNER_INDEX};

pub fn query(deps: Deps, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetCurrentRound {} => to_json_binary(&query_current_round(deps)?),
        QueryMsg::GetRoundHistory { round_id } => to_json_binary(&query_round(deps, round_id)?),
        QueryMsg::GetMyWinnings { wallet } => to_json_binary(&query_my_winnings(deps, wallet)?),
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
        QueryMsg::GetRoundEntrants { round_id } => {
            to_json_binary(&query_round_entrants(deps, round_id)?)
        }
        QueryMsg::GetWalletStats { wallet } => to_json_binary(&query_wallet_stats(deps, wallet)?),
    }
}

fn round_to_response(round: Round) -> RoundResponse {
    RoundResponse {
        round_id: round.round_id,
        status: round.status,
        ticket_count: round.entrants.len() as u64,
        unique_player_count: round.unique_players.len() as u64,
        pool: round.pool,
        opened_at: round.opened_at.seconds(),
        deadline: round.deadline.map(|t| t.seconds()),
        closed_at: round.closed_at.map(|t| t.seconds()),
        draw_after_height: round.draw_after_height,
        rearm_count: round.rearm_count,
        drawn_at: round.drawn_at.map(|t| t.seconds()),
        draw_height: round.draw_height,
        winner: round.winner,
        prize_remaining: round.prize_remaining,
        expired_at: round.expired_at.map(|t| t.seconds()),
    }
}

fn query_current_round(deps: Deps) -> StdResult<RoundResponse> {
    let state = STATE.load(deps.storage)?;
    let round = ROUNDS.load(deps.storage, state.current_round_id)?;
    Ok(round_to_response(round))
}

fn query_round(deps: Deps, round_id: u64) -> StdResult<RoundResponse> {
    let round = ROUNDS.load(deps.storage, round_id)?;
    Ok(round_to_response(round))
}

fn query_my_winnings(deps: Deps, wallet: String) -> StdResult<MyWinningsResponse> {
    let addr = deps.api.addr_validate(&wallet)?;
    let round_ids = WINNER_INDEX.may_load(deps.storage, addr)?.unwrap_or_default();
    let mut winnings = vec![];
    for round_id in round_ids {
        let round = ROUNDS.load(deps.storage, round_id)?;
        winnings.push(WinningEntry {
            round_id,
            prize_remaining: round.prize_remaining,
        });
    }
    Ok(MyWinningsResponse { winnings })
}

fn query_round_entrants(deps: Deps, round_id: u64) -> StdResult<EntrantsResponse> {
    let round = ROUNDS.load(deps.storage, round_id)?;
    Ok(EntrantsResponse {
        entrants: round.entrants,
    })
}

fn query_wallet_stats(deps: Deps, wallet: String) -> StdResult<WalletStatsResponse> {
    let addr = deps.api.addr_validate(&wallet)?;
    let total_invested = TOTAL_INVESTED.may_load(deps.storage, addr.clone())?.unwrap_or_default();
    let total_redeemed = TOTAL_REDEEMED.may_load(deps.storage, addr)?.unwrap_or_default();
    Ok(WalletStatsResponse {
        total_invested,
        total_redeemed,
    })
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        admin: config.admin,
        ticket_price: config.ticket_price,
        ticket_denom: config.ticket_denom,
        redemption_denom: config.redemption_denom,
        min_players: config.min_players,
        max_players: config.max_players,
        round_timeout_seconds: config.round_timeout_seconds,
        draw_delay_blocks: config.draw_delay_blocks,
        draw_window_blocks: config.draw_window_blocks,
        unclaimed_deadline_days: config.unclaimed_deadline_days,
        max_round_age_seconds: config.max_round_age_seconds,
        treasury_address: config.treasury_address,
        admin_fee_address: config.admin_fee_address,
        weekly_round_address: config.weekly_round_address,
    })
}
