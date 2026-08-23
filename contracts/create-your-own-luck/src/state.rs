use cosmwasm_std::{Addr, Empty, Timestamp, Uint128};
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
    /// Creator-chosen "soft-close" window (24h-31 days, see contract.rs
    /// bounds - the floor was originally 1h, raised in the round-10 audit
    /// fix, see `MIN_ROUND_TIMEOUT_SECONDS`'s own doc comment): once
    /// `min_players` is reached, `RaffleState::deadline` is set to
    /// `now + round_timeout_seconds` exactly once - not reset on every
    /// later purchase like wheel-manager's rolling deadline (that would let
    /// a couple of well-timed late purchases stretch a raffle intended to
    /// close around day 20 all the way to the 60-day hard cap, destroying
    /// the creator's planning certainty - rejected during design,
    /// 2026-08-20). A purchase landing in the FINAL hour before that
    /// deadline extends it by exactly one more hour instead
    /// (`ANTI_SNIPE_EXTENSION_SECONDS`, fixed, not creator-configurable),
    /// capped at `MAX_RAFFLE_AGE_SECONDS` from `opened_at` regardless of how
    /// many extensions accumulate.
    pub round_timeout_seconds: u64,
    pub draw_delay_blocks: u64,
    /// Width, in blocks, of the window after `draw_after_height` during which
    /// `DrawWinner` actually draws. See wheel-manager's `Config` for the full
    /// rationale.
    pub draw_window_blocks: u64,
    pub unclaimed_deadline_days: u64,
    pub prize_asset: PrizeAsset,
    /// Fixed service fee, in USDC micros - charged directly in USDC (no
    /// price-oracle conversion needed, since USDC is already dollar-pegged).
    pub fee_amount_usdc: Uint128,
    pub usdc_denom: String,
    pub founder_fee_address: Addr,
    pub treasury_address: Addr,
    /// The `create-your-own-luck-factory` that deployed this raffle - set by
    /// the factory itself at `CreateRaffle` time (a field on this contract's
    /// own `InstantiateMsg`, not hardcoded - the "simpler, field-based"
    /// option chosen over predicting the factory's address in advance via
    /// `instantiate2`, 2026-08-20). Queried live for CW20 whitelist/
    /// blacklist status at instantiate and again at CW20 deposit time. A
    /// bypass instantiate (calling this code_id directly, skipping the
    /// factory) could set this to a fake, lying "factory" - accepted as a
    /// narrow residual risk, since such a raffle would never appear in the
    /// official `GetRaffles` listing anyone using the app would see.
    pub factory_address: Addr,
    /// Winner count and prize split for `RaffleType::Podium`, in basis points
    /// (10000 = 100%), one entry per place in order (1st, 2nd, ...). Chosen by
    /// the creator at instantiate time; must sum to exactly 10000. Empty for
    /// non-Podium raffle types.
    pub podium_shares_bps: Vec<u32>,
    /// Cancellation-penalty percentages (basis points), read ONCE from the
    /// factory at this raffle's own instantiate and kept fixed for its
    /// lifetime - see create-your-own-luck-factory's `CANCELLATION_PENALTY_
    /// BASE_BPS` doc comment for why this is baked in per-raffle instead of
    /// queried live. SingleWinner/Podium only; always 0/0 for Airdrop -
    /// unlike those two, Airdrop's payout is a deterministic equal split with
    /// no draw and no odds a creator could "peek at" mid-raffle and react to;
    /// `CancelRaffle` refunds the prize to the creator and every ticket to
    /// its buyer unconditionally regardless of standing, so there's nothing a
    /// penalty here would be deterring (round-7 audit fix: corrected
    /// wording - the prior version cited the on-chain paid-airdrop fairness
    /// floor as the reason, but that check was removed the same round for
    /// being unsound across denoms; see execute_receive's own doc comment in
    /// execute.rs - the real reason above is independent of that floor's
    /// existence).
    pub cancellation_penalty_base_bps: u64,
    pub cancellation_penalty_late_additional_bps: u64,
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
    /// Soft-close deadline - `None` until `min_players` is first reached (set
    /// once, then only ever pushed later by the anti-snipe extension, never
    /// reset). See `Config::round_timeout_seconds`'s doc comment for the full
    /// mechanism.
    pub deadline: Option<Timestamp>,
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
    /// Parallel to `winners`/`prize_shares` (SingleWinner/Podium only, empty
    /// for Airdrop) - `true` once that winner's share has been confirmed paid
    /// (the prize-transfer `SubMsg`'s reply came back `Ok`), `false` while
    /// still pending or after a confirmed failure. `ExecuteMsg::
    /// RetryPrizePayout` re-sends every `false` entry - added 2026-08-20
    /// audit fix: the original design marked the raffle `Drawn` and
    /// considered the payout done regardless of whether the transfer actually
    /// succeeded, so an honest transfer failure (not just a malicious one)
    /// permanently stranded that winner's prize with no way for anyone to
    /// retry it.
    pub prize_paid: Vec<bool>,
    pub airdrop_share: Uint128,
    /// Set by `ReclaimUnclaimed` once the creator has swept whatever wasn't
    /// claimed; blocks any further `ClaimAirdropShare` calls after that point.
    pub reclaimed: bool,
    /// Consecutive prize-transfer failures against `Config::prize_asset` (only
    /// meaningful for a CW20 prize - a native `BankMsg::Send` has no way to
    /// selectively reject a recipient, and a zero-amount share is never
    /// attempted at all - see `execute.rs`'s zero-share guards - so it can
    /// never count as a failure either). Incremented in the `reply` handler
    /// for a failed prize-transfer `SubMsg` from `DrawWinner`/
    /// `RetryPrizePayout` or `ClaimAirdropShare` - genuinely reset to 0 on any
    /// successful transfer (2026-08-20 audit fix: the original `reply` handler
    /// never touched this field on the success branch at all, despite this
    /// same doc comment already claiming it did - the counter was actually
    /// cumulative over the raffle's entire life, not consecutive, which is
    /// what let a handful of unrelated failures spread across many claims
    /// permanently block every remaining claimant). At 3 in a row,
    /// `prize_blocked` is set and the token is reported to the factory's
    /// blacklist (`ReportCw20Failure`) - see execute.rs's
    /// `handle_prize_transfer_failure` for the full detection logic, which
    /// replaces an off-chain bot entirely (2026-08-20 design).
    pub prize_transfer_failures: u32,
    /// Set once `prize_transfer_failures` reaches 3 in a row - every further
    /// `RetryPrizePayout`/`ClaimAirdropShare` attempt is rejected immediately
    /// (NOT `ReclaimUnclaimed`'s own creator-facing sweep, which never checks
    /// this flag - see its own doc comment for why that's fine: it only ever
    /// sweeps genuinely-unpaid shares back to the creator, not a third
    /// party's payout) UNLESS the factory's own blacklist for this token has
    /// since been cleared by the admin (`UnblacklistCw20`), in which case the
    /// next `ClaimAirdropShare`/`RetryPrizePayout` call re-checks live and
    /// clears this flag itself (`maybe_clear_prize_blocked`, 2026-08-20 audit
    /// fix - previously this flag never healed even after the admin corrected
    /// a wrongly-blacklisted token). For a free raffle/airdrop (the common
    /// case, since paid raffles restrict CW20 to the admin-reviewed
    /// whitelist) nobody has real money trapped by this while it's set - the
    /// prize itself is the malicious/broken token, and `ReclaimUnclaimed`
    /// only counts a share as unclaimed (recoverable by the creator) if it
    /// was genuinely never paid, not merely attempted-and-failed.
    pub prize_blocked: bool,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const RAFFLE: Item<RaffleState> = Item::new("raffle");
/// wallet -> whether it already claimed its Airdrop share. Only set `true`
/// once the payout `SubMsg`'s reply confirms success (2026-08-20 audit fix -
/// previously set `true` before the transfer was even dispatched, so an
/// honest transfer failure permanently marked a claimant as paid without
/// ever paying them, with `ReclaimUnclaimed` then skipping their share too),
/// EXCEPT for the zero-share fast path (`execute_claim_airdrop_share`'s own
/// `airdrop_share.is_zero()` guard, round-13 audit fix to this comment):
/// nothing owed means nothing that could fail, so it's set `true`
/// immediately, with no dispatch and no reply at all.
/// `ReclaimUnclaimed`'s sweep formula stays correct despite that fast path
/// marking wallets claimed without paying them, precisely because
/// `airdrop_share` is zero there - those entries contribute nothing to
/// `paid_out`, so the whole prize is still recovered (round-14 audit fix to
/// this comment: the previous wording had the dependency backwards).
pub const AIRDROP_CLAIMS: Map<Addr, bool> = Map::new("airdrop_claims");
/// reply id -> the wallet whose `ClaimAirdropShare` payout that specific
/// dispatch belongs to - `reply` doesn't carry a payload in this
/// cosmwasm-std version, so this is how `handle_airdrop_claim_reply` knows
/// whose `AIRDROP_CLAIMS` entry to finalize. A `Map` keyed by a freshly
/// allocated id per dispatch (`NEXT_AIRDROP_CLAIM_REPLY_ID` below), NOT a
/// single `Item` keyed by nothing - 2026-08-20 audit fix (2nd round, found
/// independently by two reviewers). A single slot is safe under NORMAL
/// sequencing (CosmWasm resolves a dispatched SubMsg's reply before the next
/// top-level message in the same Response dispatches), but not under
/// reentrancy: a malicious CW20 prize token can, inside its own `Transfer`
/// handler, dispatch a nested call back into `ClaimAirdropShare` before the
/// outer call's reply fires, overwriting a single slot and then clearing it
/// via its own reply - leaving the outer claim's reply unable to find its
/// own claimer, erroring, and reverting the whole transaction (denying a
/// real claimant their prize without even registering as a counted
/// failure). A per-id map can't be clobbered this way: a nested dispatch
/// gets its own id and its own entry. This closes the clobbering/DoS angle,
/// but NOT double-payment - see `AIRDROP_CLAIM_IN_FLIGHT` below for the gap
/// a 3rd-round audit found in this same reentrancy scenario.
pub const PENDING_AIRDROP_CLAIMS: Map<u64, Addr> = Map::new("pending_airdrop_claims");
/// Next id to allocate for a `ClaimAirdropShare` payout dispatch - see
/// `PENDING_AIRDROP_CLAIMS`'s own doc comment.
pub const NEXT_AIRDROP_CLAIM_REPLY_ID: Item<u64> = Item::new("next_airdrop_claim_reply_id");
/// wallet -> present while that wallet has a `ClaimAirdropShare` payout
/// dispatched but not yet confirmed by its reply (2026-08-20 audit fix,
/// round 4, found independently by two reviewers). Only relevant once a
/// transfer is actually dispatched - the zero-share fast path this map is
/// never even set for skips straight to `AIRDROP_CLAIMS = true` with
/// nothing to reenter (see that const's own doc comment). For the dispatch
/// case, `AIRDROP_CLAIMS` is only set `true` in the reply, once the
/// transfer confirms - so `AlreadyClaimed` alone doesn't stop the SAME wallet
/// from entering `execute_claim_airdrop_share` a second time before the
/// first dispatch resolves. A malicious CW20 prize token that is also a
/// `unique_player` can reenter `ClaimAirdropShare` as itself from inside its
/// own `Transfer` handler, before its own reply fires: each reentrant call
/// still reads `AIRDROP_CLAIMS == false` and dispatches its own full-share
/// transfer, paying itself a multiple of its fair share out of the raffle's
/// real prize balance at other, honest claimants' expense. Set right before
/// dispatch, checked at entry (`ClaimAlreadyInFlight`), and removed in
/// `handle_airdrop_claim_reply` on both success AND failure - so an honest
/// transfer failure still clears it and remains retryable, same as before
/// this fix.
pub const AIRDROP_CLAIM_IN_FLIGHT: Map<Addr, Empty> = Map::new("airdrop_claim_in_flight");
