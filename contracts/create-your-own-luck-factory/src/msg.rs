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
        prize_native_denom: Option<String>,
        prize_cw20_address: Option<String>,
        podium_shares_bps: Vec<u32>,
    },
    /// Admin-only. Approves a CW20 token as a valid prize for PAID raffles
    /// (SingleWinner/Podium/Airdrop with `ticket_price > 0`) after manual
    /// review - see `CW20_WHITELIST`'s own doc comment.
    AddCw20ToWhitelist { address: String },
    /// Admin-only. Reverses `AddCw20ToWhitelist` - already-created raffles
    /// referencing this token are unaffected ONLY once already funded (a
    /// raffle still `Funding` re-checks live at CW20 deposit time too - see
    /// create-your-own-luck's `execute_receive`, 2026-08-20 - so removing a
    /// token here can still block a deposit that hasn't happened yet).
    RemoveCw20FromWhitelist { address: String },
    /// Admin-only. Manually clears a token from the FREE-raffle blacklist,
    /// for the case a legitimate token was wrongly auto-blacklisted (see
    /// `ReportCw20Failure`) - eg. a real bug in the token rather than
    /// deliberate malice, confirmed by the admin after investigating.
    UnblacklistCw20 { address: String },
    /// Callable only by a raffle address this factory itself deployed (see
    /// `KNOWN_RAFFLES`) - not by admin, not by any other wallet. A raffle
    /// calls this on itself once it has recorded 3 consecutive prize-
    /// transfer failures against the same CW20 token, closing the "malicious
    /// CW20 selectively blocks the draw" finding for FREE raffles/airdrops
    /// without needing an off-chain bot: the failure detection and the
    /// report both happen on-chain, inside the raffle contract's own reply
    /// handler.
    ReportCw20Failure { address: String },
    /// Admin-only. Tunes the SingleWinner/Podium cancellation-penalty
    /// percentages - see `CANCELLATION_PENALTY_BASE_BPS`'s own doc comment.
    /// Both in basis points; `base_bps + late_additional_bps` must not
    /// exceed 10000 (100%).
    SetCancellationPenaltyBps {
        base_bps: u64,
        late_additional_bps: u64,
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
    /// "unsafe-shaped" raffle, and until when. `None` only for a wallet that
    /// has never created one - the query returns the raw stored record as-is
    /// otherwise and does NOT itself re-check staleness (round-10 audit fix:
    /// this comment used to claim it also returned `None` once the streak
    /// went stale, which `query_creator_cooldown` never did - it always
    /// returns `Some(stored_timestamp)` for any existing record, regardless
    /// of age). A caller that cares about staleness must re-derive it from
    /// `next_unsafe_allowed_at` and `UNSAFE_STREAK_STALE_AFTER_DAYS` (in the
    /// factory's execute.rs) itself - see the frontend's `cyolChecklist.ts`
    /// for the reference implementation. A safe-shaped raffle never affects
    /// this.
    #[returns(CreatorCooldownResponse)]
    GetCreatorCooldown { creator: String },
    /// Whether `address` is approved as a prize for PAID raffles. Queried
    /// live by a raffle at its own instantiate (and again at CW20 deposit
    /// time) - see `CW20_WHITELIST`'s own doc comment.
    #[returns(bool)]
    IsCw20Whitelisted { address: String },
    /// Whether `address` is blocked as a prize for FREE raffles/airdrops.
    /// Queried live by a raffle at its own instantiate (and again at CW20
    /// deposit time) - see `CW20_BLACKLIST`'s own doc comment.
    #[returns(bool)]
    IsCw20Blacklisted { address: String },
    /// Current cancellation-penalty percentages - queried once by a raffle
    /// at its own instantiate and baked into its own `Config` from then on,
    /// so a later admin change never retroactively affects an already-
    /// created raffle. See `CANCELLATION_PENALTY_BASE_BPS`'s own doc comment.
    #[returns(CancellationPenaltyResponse)]
    GetCancellationPenaltyBps {},
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
pub struct CancellationPenaltyResponse {
    pub base_bps: u64,
    pub late_additional_bps: u64,
}

#[cw_serde]
pub struct CreatorCooldownResponse {
    pub unsafe_streak: u32,
    /// `None` only if this wallet has never created an unsafe-shaped raffle -
    /// NOT re-checked for staleness by the query itself (round-10 audit fix -
    /// see `GetCreatorCooldown`'s own doc comment for the caller-side
    /// staleness re-derivation this requires).
    pub next_unsafe_allowed_at: Option<u64>,
}
