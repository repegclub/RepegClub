use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};

use crate::state::RoundStatus;

#[cw_serde]
pub struct InstantiateMsg {
    pub base_ticket_price: Uint128,
    pub price_increment_per_day: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_duration_days: u64,
    pub draw_delay_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub treasury_address: String,
    pub admin_fee_address: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Called by Wheel Manager instances (or anyone) to add funds to this
    /// week's pool; open to any caller by design (worst case is a harmless
    /// bonus to the prize) rather than maintaining an admin-managed allowlist
    /// of valid Wheel Manager addresses.
    ContributeToPool { source_wheel: String, source_round_id: u64 },
    BuyWeeklyTicket {},
    CloseWeek {},
    DrawWeeklyWinner {},
    Redeem { week_id: u64 },
    SweepUstc {},
    /// Anyone can call this once `unclaimed_deadline_days` have passed since a
    /// week was drawn with an unredeemed prize - sends it to the treasury. No
    /// admin discretion involved, replacing an earlier `AdminReassignWinner`
    /// design (see security review, 2026-07-08).
    SweepExpiredPrize { week_id: u64 },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(WeekResponse)]
    GetCurrentWeek {},
    #[returns(TodayPriceResponse)]
    GetTodayPrice {},
    #[returns(WeekResponse)]
    GetWeekHistory { week_id: u64 },
    #[returns(MyWinningsResponse)]
    GetMyWinnings { wallet: String },
    #[returns(ConfigResponse)]
    GetConfig {},
}

#[cw_serde]
pub struct WeekResponse {
    pub week_id: u64,
    pub status: RoundStatus,
    pub ticket_count: u64,
    pub unique_player_count: u64,
    pub ticket_sales_pool: Uint128,
    pub wheel_contributions: Uint128,
    pub pool: Uint128,
    pub today_price: Uint128,
    pub opened_at: u64,
    pub closed_at: Option<u64>,
    pub seconds_remaining: u64,
    pub draw_after_height: Option<u64>,
    pub drawn_at: Option<u64>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
}

#[cw_serde]
pub struct TodayPriceResponse {
    pub price: Uint128,
    pub denom: String,
}

#[cw_serde]
pub struct WinningEntry {
    pub week_id: u64,
    pub prize_remaining: Uint128,
}

#[cw_serde]
pub struct MyWinningsResponse {
    pub winnings: Vec<WinningEntry>,
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: Addr,
    pub base_ticket_price: Uint128,
    pub price_increment_per_day: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_duration_days: u64,
    pub draw_delay_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
}
