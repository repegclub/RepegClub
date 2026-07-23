use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};

/// Mirrors `create-your-own-luck`'s own `RaffleType` field-for-field (same
/// snake_case serde rename via `cw_serde`) - each contract in this project
/// is an independent crate with no shared library, so this is duplicated on
/// purpose rather than pulled in as a path dependency, matching how
/// wheel-manager/weekly-round/create-your-own-luck already don't share code
/// despite overlapping concepts.
#[cw_serde]
pub enum RaffleType {
    SingleWinner,
    Podium,
    Airdrop,
}

#[cw_serde]
pub struct InstantiateMsg {
    pub raffle_code_id: u64,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Instantiates a new create-your-own-luck raffle and registers it so
    /// `GetRaffles` can list it. Field-for-field the same as
    /// create-your-own-luck's own `InstantiateMsg` - no funds needed here,
    /// the creator funds the raffle separately (`DepositPrize`/
    /// `PayServiceFee`) once its address is known from this call's events.
    ///
    /// Rejected with `CreatorOnCooldown` if this wallet is currently locked
    /// out of creating another "unsafe-shaped" raffle (paid, non-Airdrop,
    /// `max_players` below a small-raffle threshold) - see
    /// `execute::UNSAFE_MAX_PLAYERS_THRESHOLD` for why that shape is cheap to
    /// repeat for profit, and `GetCreatorCooldown` to check before calling.
    CreateRaffle {
        raffle_type: RaffleType,
        ticket_price: Uint128,
        ticket_denom: String,
        allowed_entrants: Option<Vec<String>>,
        min_players: u32,
        max_players: u32,
        round_timeout_seconds: u64,
        draw_delay_blocks: u64,
        draw_window_blocks: u64,
        unclaimed_deadline_days: u64,
        max_raffle_age_seconds: u64,
        prize_native_denom: Option<String>,
        prize_cw20_address: Option<String>,
        podium_shares_bps: Vec<u32>,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Newest-first, paginated. `start_after` is the index of the last
    /// record already seen (not a raffle address) - pass the previous
    /// response's last `index` to continue.
    #[returns(RafflesResponse)]
    GetRaffles {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    #[returns(ConfigResponse)]
    GetConfig {},
    /// Whether `creator` is currently locked out of creating another
    /// "unsafe-shaped" raffle, and until when - `None` for a wallet that has
    /// never created one, or whose streak has gone stale (no unsafe-shaped
    /// attempt in a long time - see `UNSAFE_STREAK_STALE_AFTER_DAYS` in the
    /// factory's execute.rs). A safe-shaped raffle never affects this.
    #[returns(CreatorCooldownResponse)]
    GetCreatorCooldown { creator: String },
}

#[cw_serde]
pub struct RaffleRecordResponse {
    pub index: u64,
    pub address: Addr,
    pub creator: Addr,
    pub created_at: u64,
}

#[cw_serde]
pub struct RafflesResponse {
    pub raffles: Vec<RaffleRecordResponse>,
    pub total_count: u64,
}

#[cw_serde]
pub struct ConfigResponse {
    pub raffle_code_id: u64,
}

#[cw_serde]
pub struct CreatorCooldownResponse {
    pub unsafe_streak: u32,
    /// `None` if this wallet has never created an unsafe-shaped raffle, or
    /// its streak has gone stale from a long enough dormant period since.
    pub next_unsafe_allowed_at: Option<u64>,
}
