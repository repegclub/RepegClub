use cosmwasm_std::{Addr, Empty, HexBinary, Timestamp, Uint128};
use cw_storage_plus::{Deque, Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Config {
    pub admin: Addr,
    /// See wheel-manager's matching `Config::commit_pusher` doc comment -
    /// same role, same rationale, same "no rotation" caveat.
    pub commit_pusher: Addr,
    pub base_ticket_price: Uint128,
    pub price_increment_per_day: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_duration_days: u64,
    /// Days after a week is drawn before an unredeemed prize can be swept to
    /// the treasury by anyone via `SweepExpiredPrize` (no admin discretion).
    pub unclaimed_deadline_days: u64,
    /// See wheel-manager's matching `Config` field for the full rationale.
    /// Bounded at `instantiate` - see `contract::MIN_MAX_REVEAL_AGE_SECONDS`.
    pub max_reveal_age_seconds: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RoundStatus {
    Open,
    Closed,
    /// See wheel-manager's matching `RoundStatus` variant for the full
    /// rationale - same 3-phase expiration mechanism, applied here.
    ExpiryPending,
    Drawn,
    /// Never reached `min_players` before `round_duration_days` elapsed, OR
    /// reached `Closed` but nobody ever revealed it in time - terminal
    /// either way, resolved via `ReclaimTicket` instead of `Redeem`.
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
    /// See wheel-manager's matching `Round` field for the full rationale.
    pub closed_at_height: Option<u64>,
    /// See wheel-manager's matching `Round` field.
    pub commit_used: Option<HexBinary>,
    /// See wheel-manager's matching `Round` field.
    pub revealed_preimage: Option<HexBinary>,
    /// See wheel-manager's matching `Round` field.
    pub expire_requested_at_height: Option<u64>,
    /// See wheel-manager's matching `Round` field.
    pub expiry_pending_since_height: Option<u64>,
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

/// Global, non-week-scoped state: which week is currently active. Unlike
/// wheel-manager, there's no self-generated carry between weeks (the only
/// external input is `wheel_contributions`, routed via `PENDING_CONTRIBUTIONS`
/// below - see `execute::route_carry`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct GlobalState {
    pub current_week_id: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const STATE: Item<GlobalState> = Item::new("state");
pub const WEEKS: Map<u64, Week> = Map::new("weeks");
/// Wheel Manager contributions that arrived while no week was `Open` to
/// credit them to directly - drained by `route_carry`, the next time it runs
/// with the newly-opened week as `current_week_id` (corrected 2026-08-28,
/// Ronda 10 audit fix, Opus/WR-1: a prior version of this comment claimed
/// `open_new_week` itself drains this, which it never has - `open_new_week`
/// only opens the week; `route_carry` is the only place that ever reads or
/// clears this field, same as wheel-manager's `GlobalState::next_round_carry`).
/// See that field's own doc comment for why this should be structurally
/// unreachable in normal operation, but kept as cheap defense in depth anyway.
pub const PENDING_CONTRIBUTIONS: Item<Uint128> = Item::new("pending_contributions");
/// See wheel-manager's matching constant's doc comment - same mechanism.
pub const REVEAL_QUEUE: Deque<u64> = Deque::new("reveal_queue");
/// See wheel-manager's matching constant's doc comment - same mechanism,
/// independent of wheel-manager's own queue (this contract generates and
/// manages its own commits).
pub const COMMIT_QUEUE: Deque<HexBinary> = Deque::new("commit_queue");
/// See wheel-manager's matching constant's doc comment.
pub const USED_COMMITS: Map<&[u8], Empty> = Map::new("used_commits");
/// wallet -> week_ids where that wallet is the winner and prize_remaining > 0.
pub const WINNER_INDEX: Map<Addr, Vec<u64>> = Map::new("winner_index");
/// wallet -> lifetime ticket spend across every week, net of any
/// `WithdrawTicket` refunds. Purely informational, read by `GetWalletStats`.
pub const TOTAL_INVESTED: Map<Addr, Uint128> = Map::new("total_invested");
/// wallet -> lifetime amount actually applied to a prize via `Redeem` (the
/// real payout, not any overpayment that got refunded back).
pub const TOTAL_REDEEMED: Map<Addr, Uint128> = Map::new("total_redeemed");
