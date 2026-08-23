use cosmwasm_schema::cw_serde;

/// Mirrors the subset of create-your-own-luck-factory's own `QueryMsg`/
/// `ExecuteMsg` this raffle needs to call (field names and shape, not the
/// type - same "each contract is an independent crate with no shared
/// library" duplication already used for `RaffleType` between the two
/// crates' own `msg.rs` files).
#[cw_serde]
pub enum FactoryQueryMsg {
    IsCw20Whitelisted { address: String },
    IsCw20Blacklisted { address: String },
    GetCancellationPenaltyBps {},
}

#[cw_serde]
pub struct CancellationPenaltyResponse {
    pub base_bps: u64,
    pub late_additional_bps: u64,
}

#[cw_serde]
pub enum FactoryExecuteMsg {
    /// Only accepted by the factory if `info.sender` (this raffle's own
    /// address) is in its `KNOWN_RAFFLES` set - see the factory's own
    /// `ExecuteMsg::ReportCw20Failure` doc comment.
    ReportCw20Failure { address: String },
}
