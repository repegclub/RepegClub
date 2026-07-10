use cosmwasm_std::{to_json_binary, Binary, Deps, StdResult};

use crate::msg::{ConfigResponse, MyWinningsResponse, QueryMsg, RoundResponse, WinningEntry};
use crate::state::{Round, CONFIG, ROUNDS, STATE, WINNER_INDEX};

pub fn query(deps: Deps, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetCurrentRound {} => to_json_binary(&query_current_round(deps)?),
        QueryMsg::GetRoundHistory { round_id } => to_json_binary(&query_round(deps, round_id)?),
        QueryMsg::GetMyWinnings { wallet } => to_json_binary(&query_my_winnings(deps, wallet)?),
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
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
        closed_at: round.closed_at.map(|t| t.seconds()),
        draw_after_height: round.draw_after_height,
        drawn_at: round.drawn_at.map(|t| t.seconds()),
        winner: round.winner,
        prize_remaining: round.prize_remaining,
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
        unclaimed_deadline_days: config.unclaimed_deadline_days,
        treasury_address: config.treasury_address,
        admin_fee_address: config.admin_fee_address,
        weekly_round_address: config.weekly_round_address,
    })
}
