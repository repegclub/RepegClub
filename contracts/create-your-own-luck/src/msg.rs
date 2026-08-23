use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};
use cw20::Cw20ReceiveMsg;

use crate::state::{PrizeAsset, RaffleStatus, RaffleType};

/// The service fee amount, USDC denom, and founder/treasury addresses are
/// deliberately NOT fields here - they're hardcoded platform constants in
/// contract.rs, computed/fixed rather than creator-supplied, so a raffle
/// creator can never redirect the fee or pay it in a fake token.
#[cw_serde]
pub struct InstantiateMsg {
    /// Who this raffle belongs to for every creator-gated action (DepositPrize,
    /// DrawWinner, CancelRaffle, ReclaimUnclaimed). Defaults to `info.sender`
    /// when omitted - the right default for a direct instantiate - but MUST be
    /// set explicitly by anything that instantiates this contract on someone
    /// else's behalf via a submessage (the factory): `info.sender` at that
    /// point is the calling contract itself (CosmWasm submessage semantics),
    /// not the human wallet that asked for the raffle, and a contract address
    /// can never sign a transaction - every creator-gated action would be
    /// permanently unreachable otherwise. Found live (2026-07-23): every
    /// raffle created through create-your-own-luck-factory had its `creator`
    /// silently set to the factory's own address, so DepositPrize could never
    /// succeed for anyone.
    pub creator: Option<String>,
    /// The `create-your-own-luck-factory` deploying this raffle - see
    /// `state::Config::factory_address`'s own doc comment for what this is
    /// used for and the residual risk of a direct-instantiate bypass lying
    /// about it. Required, not defaulted to `info.sender`, unlike `creator`
    /// above - a raffle instantiated with no real, responding factory behind
    /// it can't be created at all for any non-Airdrop raffle_type (native or
    /// CW20 prize alike): instantiate() queries `GetCancellationPenaltyBps`
    /// on this address unconditionally for SingleWinner/Podium (round-11
    /// audit fix - this comment used to understate the impact as "can't
    /// offer a CW20 prize", but the whitelist/blacklist queries are only the
    /// CW20-specific half of the dependency). An honest failure mode for a
    /// bypass attempt rather than something to default around.
    pub factory_address: String,
    pub raffle_type: RaffleType,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub allowed_entrants: Option<Vec<String>>,
    pub min_players: u32,
    pub max_players: u32,
    /// Creator-chosen soft-close window - see `state::Config::
    /// round_timeout_seconds`'s doc comment for the full mechanism and the
    /// 24h-31day bounds enforced in contract.rs.
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    /// Exactly one of these two must be set: a native prize (simple, single
    /// `DepositPrize` call) or a CW20 prize (needs `PayServiceFee` first, then
    /// the CW20 token's own `Send` to this contract).
    pub prize_native_denom: Option<String>,
    pub prize_cw20_address: Option<String>,
    /// Required (and must sum to 10000) when `raffle_type` is `Podium`; must
    /// be empty otherwise. See `Config::podium_shares_bps`.
    pub podium_shares_bps: Vec<u32>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Native-prize raffles only: attaches the prize + the USDC fee in one call.
    DepositPrize {},
    /// CW20-prize raffles only: pays the USDC fee ahead of sending the CW20
    /// prize (a CW20 `Send` can't also carry native funds in the same tx).
    PayServiceFee {},
    /// Invoked by a CW20 token contract when the creator calls its `Send`
    /// with this raffle as the recipient - the actual CW20 prize deposit path.
    Receive(Cw20ReceiveMsg),
    BuyTicket {},
    /// Self-service refund for the caller's own tickets, only while the
    /// raffle hasn't reached `min_players` yet.
    WithdrawTicket {},
    CloseRound {},
    DrawWinner {},
    /// SingleWinner/Podium only, permissionless: re-sends the prize share for
    /// any winner whose payout hasn't been confirmed paid yet (see
    /// `state::RaffleState::prize_paid`) - added 2026-08-20 audit fix so a
    /// transfer that failed for an honest reason (not just a malicious
    /// token) isn't stranded forever with no way for anyone to retry it.
    /// Also re-checks the factory's current CW20 blacklist status and clears
    /// this raffle's own `prize_blocked` flag if the admin has since cleared
    /// it there.
    RetryPrizePayout {},
    ClaimAirdropShare {},
    ReclaimUnclaimed {},
    CancelRaffle {},
    /// Permissionless: if the raffle never reached `min_players` within
    /// `MAX_RAFFLE_AGE_SECONDS` (fixed platform-wide, not creator-chosen -
    /// see that constant's own doc comment), anyone can force a full refund
    /// (prize+fee to the creator, tickets to each buyer) - the safety net
    /// for a stalled raffle whose creator is unresponsive, mirroring
    /// `CancelRaffle`'s own refund logic but without needing the creator to
    /// act.
    ExpireRaffle {},
}

/// Embedded (base64-encoded) in the CW20 `Send.msg` field to tell `Receive`
/// what to do with the incoming tokens.
#[cw_serde]
pub enum Cw20HookMsg {
    DepositPrize {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(RaffleStatusResponse)]
    GetRaffleStatus {},
    #[returns(WinnersResponse)]
    GetWinners {},
    #[returns(MyAirdropShareResponse)]
    GetMyAirdropShare { wallet: String },
    #[returns(ConfigResponse)]
    GetConfig {},
    /// Full ticket list, one entry per ticket (duplicates for a wallet
    /// holding more than one) - same shape as wheel-manager's
    /// GetRoundEntrants, lets the frontend compute a wallet's own ticket
    /// count (no dedicated per-wallet query exists, mirroring that contract).
    #[returns(EntrantsResponse)]
    GetEntrants {},
}

#[cw_serde]
pub struct RaffleStatusResponse {
    pub status: RaffleStatus,
    pub raffle_type: RaffleType,
    pub ticket_count: u64,
    pub unique_player_count: u64,
    pub prize_amount: Uint128,
    pub prize_asset: PrizeAsset,
    pub fee_paid: bool,
    pub opened_at: Option<u64>,
    pub closed_at: Option<u64>,
    pub seconds_remaining: Option<u64>,
    pub draw_after_height: Option<u64>,
    /// The actual block height used in the winner-selection hash, for the
    /// public verification panel - `None` until the raffle is `Drawn`.
    pub draw_height: Option<u64>,
}

#[cw_serde]
pub struct WinnersResponse {
    pub winners: Vec<Addr>,
    pub prize_shares: Vec<Uint128>,
    /// Parallel to the two fields above - see `state::RaffleState::
    /// prize_paid`'s doc comment. Lets the frontend show "payout pending,
    /// retry available" instead of implying a drawn winner has already been
    /// paid.
    pub prize_paid: Vec<bool>,
}

#[cw_serde]
pub struct EntrantsResponse {
    pub entrants: Vec<Addr>,
}

#[cw_serde]
pub struct MyAirdropShareResponse {
    pub share: Uint128,
    pub claimed: bool,
}

#[cw_serde]
pub struct ConfigResponse {
    pub creator: Addr,
    pub raffle_type: RaffleType,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub allowed_entrants: Option<Vec<Addr>>,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub prize_asset: PrizeAsset,
    pub fee_amount_usdc: Uint128,
    pub usdc_denom: String,
    pub founder_fee_address: Addr,
    pub treasury_address: Addr,
    pub factory_address: Addr,
    pub podium_shares_bps: Vec<u32>,
    pub cancellation_penalty_base_bps: u64,
    pub cancellation_penalty_late_additional_bps: u64,
}
