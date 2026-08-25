use cosmwasm_std::{Addr, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Config {
    pub admin: Addr,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    /// Width, in blocks, of the window after `draw_after_height` during which
    /// `DrawWinner` actually draws. Bounds how many blocks a caller can wait
    /// through (each one a free off-chain simulation of the outcome) before
    /// having to accept whatever comes up - without this, the window is
    /// unbounded and a patient caller (or a colluding block proposer) can
    /// grind indefinitely for a favorable block. See `rand.rs` for the full
    /// randomness caveat and `execute_draw_winner` for the rearm behavior.
    pub draw_window_blocks: u64,
    /// Days after a round is drawn before an unredeemed prize can be swept to
    /// the treasury by anyone via `SweepExpiredPrize` (no admin discretion
    /// involved - a fixed, automatic deadline).
    pub unclaimed_deadline_days: u64,
    /// Hard ceiling, in seconds since a round opened, on how long it can stay
    /// Open - independent of the rolling soft-close `deadline`. Serves two
    /// purposes: (1) if `min_players` is never reached, it's when
    /// `ExpireRound` becomes callable so buyers can reclaim their tickets
    /// instead of funds being stuck forever; (2) if `min_players` was reached
    /// but the rolling deadline keeps getting pushed forward by new tickets,
    /// it caps how long that extension can go on before `CloseRound` is
    /// forced regardless.
    pub max_round_age_seconds: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
    pub weekly_round_address: Addr,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RoundStatus {
    Open,
    Closed,
    Drawn,
    /// Never reached `min_players` before `max_round_age_seconds` elapsed -
    /// terminal, like `Drawn`, but resolved via `ReclaimTicket` instead of
    /// `Redeem` since there's no winner, just buyers getting their own money
    /// back.
    Expired,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Round {
    pub round_id: u64,
    pub status: RoundStatus,
    pub entrants: Vec<Addr>,
    pub unique_players: Vec<Addr>,
    pub pool: Uint128,
    pub opened_at: Timestamp,
    /// Rolling close deadline - unset until `min_players` is reached, then
    /// pushed forward by `round_timeout_seconds` on every ticket purchase
    /// from then on (an auction-style "soft close" extension, not a fixed
    /// timer from `opened_at`). `CloseRound` becomes callable once this
    /// passes with nobody having bought a ticket in the meantime.
    pub deadline: Option<Timestamp>,
    pub closed_at: Option<Timestamp>,
    pub draw_after_height: Option<u64>,
    /// How many times `DrawWinner` has rearmed the draw window for this round
    /// (see `execute_draw_winner`'s `MAX_REARMS` doc comment) - capped so a
    /// patient off-chain grinder can't re-roll for a favorable block forever.
    pub rearm_count: u32,
    pub drawn_at: Option<Timestamp>,
    /// Exact block height the winner-picking hash was computed at (see
    /// `rand::pick_winner_index`) - `draw_after_height` is only the *minimum*
    /// required height, not necessarily the one actually used, so this is
    /// stored separately to let anyone verify the draw from the query alone.
    pub draw_height: Option<u64>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
    /// Set when the round transitions to `Expired` (see `max_round_age_seconds`).
    pub expired_at: Option<Timestamp>,
}

/// Global, non-round-scoped state: which round is currently active, and how
/// much of the 5% "next round" cut has accumulated for it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct GlobalState {
    pub current_round_id: u64,
    pub next_round_carry: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const STATE: Item<GlobalState> = Item::new("state");
pub const ROUNDS: Map<u64, Round> = Map::new("rounds");
/// wallet -> round_ids where that wallet is the winner and prize_remaining > 0.
pub const WINNER_INDEX: Map<Addr, Vec<u64>> = Map::new("winner_index");
/// wallet -> lifetime ticket spend across every round, net of any
/// `WithdrawTicket` refunds (money withdrawn was never really at stake, so it
/// doesn't count as "invested"). Purely informational, read by
/// `GetWalletStats` for the frontend's "how much have I put in" display.
pub const TOTAL_INVESTED: Map<Addr, Uint128> = Map::new("total_invested");
/// wallet -> lifetime amount actually applied to a prize via `Redeem` (the
/// real payout, not any overpayment that got refunded back). Not derivable
/// from `WINNER_INDEX` alone, since a fully-redeemed entry is removed from it.
pub const TOTAL_REDEEMED: Map<Addr, Uint128> = Map::new("total_redeemed");
