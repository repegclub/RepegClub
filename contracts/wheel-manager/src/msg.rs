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
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub max_round_age_seconds: u64,
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
    /// to any address at any time (see security review, 2026-07-08). Also
    /// handles sweeping an `Expired` round's abandoned (unreclaimed) pool
    /// after the same deadline, measured from `expired_at` instead.
    SweepExpiredPrize { round_id: u64 },
    /// Permissionless. Marks the current round `Expired` if `min_players` was
    /// never reached and `max_round_age_seconds` has elapsed since it opened,
    /// then immediately opens the next round so the game isn't stuck. Ticket
    /// money stays in the expired round for `ReclaimTicket`; only the
    /// carried-in amount from the previous round's 5% cut (nobody's specific
    /// ticket money) rolls forward.
    ExpireRound {},
    /// Callable by any wallet that bought a ticket in an `Expired` round -
    /// refunds exactly what that wallet paid (ticket_price * their ticket
    /// count) and removes them from that round's entrant list.
    ReclaimTicket { round_id: u64 },
    /// Self-service refund for a wallet's own tickets in the current round,
    /// only while `min_players` hasn't been reached yet (once it has, the
    /// rolling close deadline is live and withdrawing would let a player
    /// watch the round develop then bail, which isn't allowed). Refunds
    /// exactly what that wallet paid and removes it from the round -
    /// deliberately no minimum wait before a second player shows up.
    WithdrawTicket { round_id: u64 },
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
    /// Full per-ticket entrant list for a round (one entry per ticket,
    /// duplicates for wallets that bought more than one) - not included in
    /// `RoundResponse` itself since most callers only need the aggregate
    /// counts already there. Needed by frontends that render the wheel's
    /// per-wallet segments.
    #[returns(EntrantsResponse)]
    GetRoundEntrants { round_id: u64 },
    /// Lifetime per-wallet totals, for the frontend's "how much have I
    /// invested" / "how much USTC have I actually repegged" display.
    #[returns(WalletStatsResponse)]
    GetWalletStats { wallet: String },
}

#[cw_serde]
pub struct RoundResponse {
    pub round_id: u64,
    pub status: RoundStatus,
    pub ticket_count: u64,
    pub unique_player_count: u64,
    pub pool: Uint128,
    pub opened_at: u64,
    /// Rolling close deadline (unix seconds) - unset until min_players is
    /// reached, then pushed forward on every ticket purchase. Lets a
    /// frontend show a live countdown to when CloseRound becomes callable.
    pub deadline: Option<u64>,
    pub closed_at: Option<u64>,
    pub draw_after_height: Option<u64>,
    pub drawn_at: Option<u64>,
    /// Exact block height the winner-picking hash was computed at - lets
    /// anyone independently recompute `SHA-256(round_id + draw_height +
    /// drawn_at's block time + entrants)` and check it against `winner`.
    pub draw_height: Option<u64>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
    pub expired_at: Option<u64>,
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
pub struct EntrantsResponse {
    pub entrants: Vec<Addr>,
}

#[cw_serde]
pub struct WalletStatsResponse {
    pub total_invested: Uint128,
    pub total_redeemed: Uint128,
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
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub max_round_age_seconds: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
    pub weekly_round_address: Addr,
}
