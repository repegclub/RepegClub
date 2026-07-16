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
    pub draw_window_blocks: u64,
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
    /// Permissionless. Marks the current week `Expired` if `min_players` was
    /// never reached and `round_duration_days` has elapsed since it opened,
    /// then immediately opens the next week so the game isn't stuck. Ticket
    /// money stays in the expired week for `ReclaimTicket`; only
    /// `wheel_contributions` (not any specific buyer's money) rolls forward.
    ExpireWeek {},
    /// Callable by any wallet that bought a ticket in an `Expired` week -
    /// refunds exactly what that wallet paid and removes it from that
    /// week's entrant list.
    ReclaimTicket { week_id: u64 },
    /// Self-service refund for a wallet's own tickets in the current week,
    /// only while `min_players` hasn't been reached yet. Refunds exactly what
    /// that wallet paid (per `ticket_payments`, since price ramps by day) and
    /// removes it from the week - deliberately no minimum wait before a
    /// second player shows up.
    WithdrawTicket { week_id: u64 },
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
    /// Lifetime per-wallet totals, for the frontend's "how much have I
    /// invested" / "how much USTC have I actually repegged" display.
    #[returns(WalletStatsResponse)]
    GetWalletStats { wallet: String },
    /// Full ordered entrant list for a week (one entry per ticket, duplicates
    /// for wallets that bought more than one) - mirrors Wheel Manager's
    /// GetRoundEntrants. Needed to independently recompute a drawn week's
    /// winner (see rand.rs) for the frontend's public verification panel;
    /// GetWeekHistory alone only has the counts already there.
    #[returns(EntrantsResponse)]
    GetWeekEntrants { week_id: u64 },
}

#[cw_serde]
pub struct EntrantsResponse {
    pub entrants: Vec<Addr>,
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
    pub draw_height: Option<u64>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
    pub expired_at: Option<u64>,
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
pub struct WalletStatsResponse {
    pub total_invested: Uint128,
    pub total_redeemed: Uint128,
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
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
}
