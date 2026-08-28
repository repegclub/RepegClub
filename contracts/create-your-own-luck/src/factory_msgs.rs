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
    /// Consumes the next queued commit and returns it (via the reply's
    /// `data`) - only accepted if `info.sender` is a raffle the factory
    /// itself instantiated, and only once per raffle. Dispatched as a
    /// `SubMsg::reply_on_success` from `execute_deposit_prize`/
    /// `execute_receive` the moment the fee/prize is funded - see the
    /// factory's own `ExecuteMsg::ConsumeCommit` doc comment.
    ConsumeCommit {},
    /// Returns an unconsumed commit to the factory's queue - only valid for
    /// a raffle that consumed one via `ConsumeCommit` but never used it in
    /// any hash (i.e. never reached `Drawn`). See the factory's own
    /// `ExecuteMsg::ReturnCommit` doc comment for why this exists (closes a
    /// cheap DoS on the commit queue) and why it's safe to recycle (the
    /// preimage was never revealed, so reusing the commit leaks nothing).
    ReturnCommit {},
}
