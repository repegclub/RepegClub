use cosmwasm_std::{Addr, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RaffleType {
    SingleWinner,
    Podium,
    Airdrop,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RaffleStatus {
    /// Waiting for the creator to fund the raffle (native `DepositPrize`, or
    /// `PayServiceFee` + a CW20 `Send` for CW20 prizes); ticket sales not open yet.
    Funding,
    Open,
    Closed,
    Drawn,
    Cancelled,
}

/// What the prize is denominated in. Native prizes are funded in a single
/// `DepositPrize` call (funds attached); CW20 prizes can't be attached to a
/// call like that (CW20 balances live in the token contract's own storage,
/// not the bank module), so they go through `PayServiceFee` followed by the
/// CW20 contract's own `Send`, which invokes this contract's `Receive` hook.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PrizeAsset {
    Native { denom: String },
    Cw20 { address: Addr },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Config {
    pub creator: Addr,
    pub raffle_type: RaffleType,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub allowed_entrants: Option<Vec<Addr>>,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    /// Width, in blocks, of the window after `draw_after_height` during which
    /// `DrawWinner` actually draws. See wheel-manager's `Config` for the full
    /// rationale.
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    /// How long a raffle can sit `Open` without reaching `min_players` before
    /// anyone (not just the creator) can call `ExpireRaffle` to force a full
    /// refund. A separate clock from `round_timeout_seconds`, which only
    /// governs closing *after* `min_players` is already met.
    pub max_raffle_age_seconds: u64,
    pub prize_asset: PrizeAsset,
    /// Fixed service fee, in USDC micros - charged directly in USDC (no
    /// price-oracle conversion needed, since USDC is already dollar-pegged).
    pub fee_amount_usdc: Uint128,
    pub usdc_denom: String,
    pub founder_fee_address: Addr,
    pub treasury_address: Addr,
    /// Winner count and prize split for `RaffleType::Podium`, in basis points
    /// (10000 = 100%), one entry per place in order (1st, 2nd, ...). Chosen by
    /// the creator at instantiate time; must sum to exactly 10000. Empty for
    /// non-Podium raffle types.
    pub podium_shares_bps: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct RaffleState {
    pub status: RaffleStatus,
    pub entrants: Vec<Addr>,
    pub unique_players: Vec<Addr>,
    pub ticket_revenue: Uint128,
    pub prize_amount: Uint128,
    /// USDC service fee, held at `DepositPrize`/`PayServiceFee` time;
    /// distributed at `DrawWinner`, refunded to the creator at `CancelRaffle`.
    pub fee_amount: Uint128,
    pub fee_paid: bool,
    pub opened_at: Option<Timestamp>,
    pub closed_at: Option<Timestamp>,
    pub draw_after_height: Option<u64>,
    /// Counts `DrawWinner` calls that landed past `draw_window_blocks` and
    /// silently rearmed instead of drawing. Bounds how many free re-rolls a
    /// creator gets before drawing opens up to anyone - see
    /// `MAX_REARMS_BEFORE_PERMISSIONLESS` in execute.rs for why an unbounded
    /// count is a real grinding risk, not just a UX inconvenience.
    pub rearm_count: u32,
    pub drawn_at: Option<Timestamp>,
    /// The actual block height used in the winner-selection hash (as opposed
    /// to `draw_after_height`, which is only the *minimum* allowed height) -
    /// needed for the public "verify this raffle" recomputation, same reason
    /// wheel-manager/weekly-round persist their own `draw_height`.
    pub draw_height: Option<u64>,
    /// 1 entry for SingleWinner, `podium_shares_bps.len()` for Podium (in
    /// place order), empty for Airdrop (uses `airdrop_share` +
    /// `AIRDROP_CLAIMS` instead).
    pub winners: Vec<Addr>,
    pub prize_shares: Vec<Uint128>,
    pub airdrop_share: Uint128,
    /// Set by `ReclaimUnclaimed` once the creator has swept whatever wasn't
    /// claimed; blocks any further `ClaimAirdropShare` calls after that point.
    pub reclaimed: bool,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const RAFFLE: Item<RaffleState> = Item::new("raffle");
/// wallet -> whether it already claimed its Airdrop share.
pub const AIRDROP_CLAIMS: Map<Addr, bool> = Map::new("airdrop_claims");
