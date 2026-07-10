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
    /// Days after a round is drawn before an unredeemed prize can be swept to
    /// the treasury by anyone via `SweepExpiredPrize` (no admin discretion
    /// involved - a fixed, automatic deadline).
    pub unclaimed_deadline_days: u64,
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Round {
    pub round_id: u64,
    pub status: RoundStatus,
    pub entrants: Vec<Addr>,
    pub unique_players: Vec<Addr>,
    pub pool: Uint128,
    pub opened_at: Timestamp,
    pub closed_at: Option<Timestamp>,
    pub draw_after_height: Option<u64>,
    pub drawn_at: Option<Timestamp>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
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
