use cosmwasm_std::{Addr, Timestamp};
use cw_storage_plus::{Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct RaffleRecord {
    pub address: Addr,
    pub creator: Addr,
    pub created_at: Timestamp,
}

/// Code ID of the `create-your-own-luck` contract this factory instantiates.
/// Fixed at deploy time - same "redeploy on change" philosophy as every
/// other platform constant in this project (no `migrate` entry point here
/// either). If the raffle contract's code ever changes, redeploy both it
/// and this factory together with the new code ID.
pub const RAFFLE_CODE_ID: Item<u64> = Item::new("raffle_code_id");

pub const RAFFLE_COUNT: Item<u64> = Item::new("raffle_count");
pub const RAFFLES: Map<u64, RaffleRecord> = Map::new("raffles");

/// Stashed right before dispatching the Instantiate SubMsg, consumed by the
/// `reply` handler once the new contract's address is known and removed
/// immediately after. SubMsg replies run synchronously within the same
/// transaction as the triggering execute, so there's no cross-tx race to
/// guard against - this is just a hand-off slot, not concurrent state.
pub const PENDING_CREATOR: Item<Addr> = Item::new("pending_creator");

/// Growing cooldown for repeating "unsafe-shaped" raffles from the same
/// creator (2026-07-22) - see `execute::UNSAFE_MAX_PLAYERS_THRESHOLD` for
/// what that means and why it needs a disincentive. A creator with no entry
/// here has never created one, or their streak was reset by a safe-shaped
/// raffle since.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct CreatorCooldown {
    pub unsafe_streak: u32,
    pub next_unsafe_allowed_at: Timestamp,
}

pub const CREATOR_COOLDOWNS: Map<Addr, CreatorCooldown> = Map::new("creator_cooldowns");
