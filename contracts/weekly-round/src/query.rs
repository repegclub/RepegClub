use cosmwasm_std::{to_json_binary, Binary, Deps, Env, StdResult};

use crate::execute::today_price;
use crate::msg::{
    ConfigResponse, EntrantsResponse, MyWinningsResponse, QueryMsg, TodayPriceResponse,
    WalletStatsResponse, WeekResponse, WinningEntry,
};
use crate::state::{Week, CONFIG, STATE, TOTAL_INVESTED, TOTAL_REDEEMED, WEEKS, WINNER_INDEX};

pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetCurrentWeek {} => to_json_binary(&query_current_week(deps, env)?),
        QueryMsg::GetTodayPrice {} => to_json_binary(&query_today_price(deps, env)?),
        QueryMsg::GetWeekHistory { week_id } => to_json_binary(&query_week(deps, env, week_id)?),
        QueryMsg::GetMyWinnings { wallet } => to_json_binary(&query_my_winnings(deps, wallet)?),
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
        QueryMsg::GetWalletStats { wallet } => to_json_binary(&query_wallet_stats(deps, wallet)?),
        QueryMsg::GetWeekEntrants { week_id } => to_json_binary(&query_week_entrants(deps, week_id)?),
    }
}

fn query_week_entrants(deps: Deps, week_id: u64) -> StdResult<EntrantsResponse> {
    let week = WEEKS.load(deps.storage, week_id)?;
    Ok(EntrantsResponse {
        entrants: week.entrants,
    })
}

fn week_to_response(week: Week, seconds_remaining: u64, price: cosmwasm_std::Uint128) -> WeekResponse {
    WeekResponse {
        week_id: week.week_id,
        status: week.status,
        ticket_count: week.entrants.len() as u64,
        unique_player_count: week.unique_players.len() as u64,
        ticket_sales_pool: week.ticket_sales_pool,
        wheel_contributions: week.wheel_contributions,
        pool: week.pool(),
        today_price: price,
        opened_at: week.opened_at.seconds(),
        closed_at: week.closed_at.map(|t| t.seconds()),
        seconds_remaining,
        draw_after_height: week.draw_after_height,
        rearm_count: week.rearm_count,
        drawn_at: week.drawn_at.map(|t| t.seconds()),
        draw_height: week.draw_height,
        winner: week.winner,
        prize_remaining: week.prize_remaining,
        expired_at: week.expired_at.map(|t| t.seconds()),
    }
}

fn seconds_remaining_for(week: &Week, env: &Env, round_duration_days: u64) -> u64 {
    let deadline = week.opened_at.seconds() + round_duration_days * 86400;
    deadline.saturating_sub(env.block.time.seconds())
}

fn query_current_week(deps: Deps, env: Env) -> StdResult<WeekResponse> {
    let config = CONFIG.load(deps.storage)?;
    let state = STATE.load(deps.storage)?;
    let week = WEEKS.load(deps.storage, state.current_week_id)?;
    let remaining = seconds_remaining_for(&week, &env, config.round_duration_days);
    let price = today_price(&config, &week, env.block.time);
    Ok(week_to_response(week, remaining, price))
}

fn query_today_price(deps: Deps, env: Env) -> StdResult<TodayPriceResponse> {
    let config = CONFIG.load(deps.storage)?;
    let state = STATE.load(deps.storage)?;
    let week = WEEKS.load(deps.storage, state.current_week_id)?;
    Ok(TodayPriceResponse {
        price: today_price(&config, &week, env.block.time),
        denom: config.ticket_denom,
    })
}

fn query_week(deps: Deps, env: Env, week_id: u64) -> StdResult<WeekResponse> {
    let config = CONFIG.load(deps.storage)?;
    let week = WEEKS.load(deps.storage, week_id)?;
    let remaining = seconds_remaining_for(&week, &env, config.round_duration_days);
    let price = today_price(&config, &week, env.block.time);
    Ok(week_to_response(week, remaining, price))
}

fn query_my_winnings(deps: Deps, wallet: String) -> StdResult<MyWinningsResponse> {
    let addr = deps.api.addr_validate(&wallet)?;
    let week_ids = WINNER_INDEX.may_load(deps.storage, addr)?.unwrap_or_default();
    let mut winnings = vec![];
    for week_id in week_ids {
        let week = WEEKS.load(deps.storage, week_id)?;
        winnings.push(WinningEntry {
            week_id,
            prize_remaining: week.prize_remaining,
        });
    }
    Ok(MyWinningsResponse { winnings })
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
        base_ticket_price: config.base_ticket_price,
        price_increment_per_day: config.price_increment_per_day,
        ticket_denom: config.ticket_denom,
        redemption_denom: config.redemption_denom,
        min_players: config.min_players,
        max_players: config.max_players,
        round_duration_days: config.round_duration_days,
        draw_delay_blocks: config.draw_delay_blocks,
        draw_window_blocks: config.draw_window_blocks,
        unclaimed_deadline_days: config.unclaimed_deadline_days,
        treasury_address: config.treasury_address,
        admin_fee_address: config.admin_fee_address,
    })
}
