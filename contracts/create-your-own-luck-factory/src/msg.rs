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
