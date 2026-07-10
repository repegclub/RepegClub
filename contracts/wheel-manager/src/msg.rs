use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};

use crate::state::RoundStatus;

#[cw_serde]
pub struct InstantiateMsg {
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub treasury_address: String,
    pub admin_fee_address: String,
    pub weekly_round_address: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    BuyTicket {},
    CloseRound {},
    DrawWinner {},
    Redeem { round_id: u64 },
    SweepUstc {},
    /// Anyone can call this once `unclaimed_deadline_days` have passed since a
    /// round was drawn with an unredeemed prize - sends it to the treasury.
    /// No admin discretion involved, deliberately replacing an earlier
    /// `AdminReassignWinner` design that let the admin redirect a live prize
    /// to any address at any time (see security review, 2026-07-08).
    SweepExpiredPrize { round_id: u64 },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(RoundResponse)]
    GetCurrentRound {},
    #[returns(RoundResponse)]
    GetRoundHistory { round_id: u64 },
    #[returns(MyWinningsResponse)]
    GetMyWinnings { wallet: String },
    #[returns(ConfigResponse)]
    GetConfig {},
}

#[cw_serde]
pub struct RoundResponse {
    pub round_id: u64,
    pub status: RoundStatus,
    pub ticket_count: u64,
    pub unique_player_count: u64,
    pub pool: Uint128,
    pub opened_at: u64,
    pub closed_at: Option<u64>,
    pub draw_after_height: Option<u64>,
    pub drawn_at: Option<u64>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
}

#[cw_serde]
pub struct WinningEntry {
    pub round_id: u64,
    pub prize_remaining: Uint128,
}

#[cw_serde]
pub struct MyWinningsResponse {
    pub winnings: Vec<WinningEntry>,
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: Addr,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
    pub weekly_round_address: Addr,
}
