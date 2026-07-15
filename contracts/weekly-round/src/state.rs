use cosmwasm_std::{Addr, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Config {
    pub admin: Addr,
    pub base_ticket_price: Uint128,
    pub price_increment_per_day: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_duration_days: u64,
    pub draw_delay_blocks: u64,
    /// Width, in blocks, of the window after `draw_after_height` during which
    /// `DrawWeeklyWinner` actually draws. See the matching field in
    /// wheel-manager's `Config` for the full rationale.
    pub draw_window_blocks: u64,
    /// Days after a week is drawn before an unredeemed prize can be swept to
    /// the treasury by anyone via `SweepExpiredPrize` (no admin discretion).
    pub unclaimed_deadline_days: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RoundStatus {
    Open,
    Closed,
    Drawn,
    /// Never reached `min_players` before `round_duration_days` elapsed -
    /// terminal, resolved via `ReclaimTicket` instead of `Redeem` since
    /// there's no winner, just buyers getting their own money back.
    Expired,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Week {
    pub week_id: u64,
    pub status: RoundStatus,
    pub entrants: Vec<Addr>,
    pub unique_players: Vec<Addr>,
    pub ticket_sales_pool: Uint128,
    pub wheel_contributions: Uint128,
    /// Exact amount each wallet has paid in ticket purchases this week -
    /// needed (unlike Wheel Manager) because the day-based price ramp means
    /// different wallets can pay different amounts per ticket, so a refund
    /// can't be derived from a fixed price * ticket count.
    pub ticket_payments: Vec<(Addr, Uint128)>,
    pub opened_at: Timestamp,
    pub closed_at: Option<Timestamp>,
    pub draw_after_height: Option<u64>,
    pub drawn_at: Option<Timestamp>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
    /// Set when the week transitions to `Expired`.
    pub expired_at: Option<Timestamp>,
}

impl Week {
    pub fn pool(&self) -> Uint128 {
        self.ticket_sales_pool + self.wheel_contributions
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct GlobalState {
    pub current_week_id: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const STATE: Item<GlobalState> = Item::new("state");
pub const WEEKS: Map<u64, Week> = Map::new("weeks");
/// wallet -> week_ids where that wallet is the winner and prize_remaining > 0.
pub const WINNER_INDEX: Map<Addr, Vec<u64>> = Map::new("winner_index");
/// wallet -> lifetime ticket spend across every week, net of any
/// `WithdrawTicket` refunds. Purely informational, read by `GetWalletStats`.
pub const TOTAL_INVESTED: Map<Addr, Uint128> = Map::new("total_invested");
/// wallet -> lifetime amount actually applied to a prize via `Redeem` (the
/// real payout, not any overpayment that got refunded back).
pub const TOTAL_REDEEMED: Map<Addr, Uint128> = Map::new("total_redeemed");
