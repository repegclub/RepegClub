use cosmwasm_std::{Addr, Empty, HexBinary, Timestamp};
use cw_storage_plus::{Deque, Item, Map};
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
/// here has never created one, or their streak has gone stale (a long
/// enough dormant period, see `execute::UNSAFE_STREAK_STALE_AFTER_DAYS`).
/// Deliberately *not* affected by creating a safe-shaped raffle in the
/// meantime - that would cost nothing and let a determined creator wipe an
/// active cooldown for free (found by a CodeRabbit review, 2026-07-22).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct CreatorCooldown {
    pub unsafe_streak: u32,
    pub next_unsafe_allowed_at: Timestamp,
}

pub const CREATOR_COOLDOWNS: Map<Addr, CreatorCooldown> = Map::new("creator_cooldowns");

/// Set once at instantiate to `info.sender` (the same `ADMIN_MNEMONIC`
/// wallet already used to deploy every contract in this project - see
/// wheel-manager's identical `admin: info.sender.clone()` pattern). Gates
/// `AddCw20ToWhitelist`/`RemoveCw20FromWhitelist`/`UnblacklistCw20`/
/// `SetCancellationPenaltyBps`. `ReportCw20Failure` is deliberately NOT
/// admin-gated - see its own doc comment on `ExecuteMsg`.
pub const ADMIN: Item<Addr> = Item::new("admin");

/// See wheel-manager's matching `Config::commit_pusher` doc comment - same
/// role, same rationale, same "no rotation" caveat. Gates `PushCommits`
/// only - deliberately NOT `ADMIN` above.
pub const COMMIT_PUSHER: Item<Addr> = Item::new("commit_pusher");

/// CW20 tokens approved as prizes for PAID raffles - added only after
/// manual review (liquidity, volume, community standing, confirmed non-
/// malicious transfer behavior), the same bar create-your-own-luck's own
/// `ALLOWED_PAID_NATIVE_PRIZE_DENOMS` already applies to natives, extended
/// to CW20 via this admin-updatable registry instead of a code constant so
/// approving a new token doesn't need a contract redeploy. Presence as a
/// key means whitelisted - the `Empty` value carries no data.
pub const CW20_WHITELIST: Map<&Addr, Empty> = Map::new("cw20_whitelist");

/// CW20 tokens blocked as prizes for FREE raffles/airdrops - opt-OUT, not
/// opt-in like the paid whitelist above (default: any CW20 is allowed).
/// Populated automatically by a raffle instance reporting 3 consecutive
/// prize-transfer failures against the same token via `ReportCw20Failure`
/// (see create-your-own-luck's reply-handler doc comment for the detection
/// logic) - never touched by admin directly except `UnblacklistCw20`, for
/// the case a legitimate token got wrongly caught.
pub const CW20_BLACKLIST: Map<&Addr, Empty> = Map::new("cw20_blacklist");

/// Every raffle address this factory has ever deployed, indexed for O(1)
/// membership lookup (unlike `RAFFLES`, keyed by index, not address) - lets
/// `ReportCw20Failure` authenticate "this call really came from a raffle
/// this factory itself deployed" without a separate bot key or scanning
/// `RAFFLES` linearly. Saved alongside `RAFFLES` in the create-raffle reply
/// handler, never removed.
pub const KNOWN_RAFFLES: Map<&Addr, Empty> = Map::new("known_raffles");

/// Cancellation-penalty percentages on the SERVICE FEE (never the prize),
/// SingleWinner/Podium raffles only - see create-your-own-luck's own
/// `execute_cancel_raffle` for the full logic. `BASE` applies to any
/// cancellation once the fee is paid; `LATE_ADDITIONAL` stacks on top once
/// `min_players` is reached (base + late_additional = 100% forfeited then).
/// In basis points (10000 = 100%); admin-updatable so the platform can tune
/// this without a redeploy - but each raffle reads these ONCE, at its own
/// instantiate, and keeps that value for its lifetime, so a later admin
/// change never retroactively changes the number a creator is warned about
/// (round-8 audit fix: corrected wording - a prior version of this comment
/// claimed a "fund-time disclaimer checkbox" already existed; nothing on
/// the frontend disclosed this bps at all until this round added a
/// confirm-with-checkbox warning at CANCEL time, not fund time - see
/// `RaffleDetailPage.tsx`'s `cancelPenaltyBps`).
pub const CANCELLATION_PENALTY_BASE_BPS: Item<u64> = Item::new("cancellation_penalty_base_bps");
pub const CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS: Item<u64> =
    Item::new("cancellation_penalty_late_additional_bps");

/// Commits (`sha256(preimage)`) pushed by the admin ahead of time (generated
/// offline, alongside the preimages the keeper holds) for SingleWinner/Podium
/// raffles to consume via `ConsumeCommit` when they're funded - same pattern
/// as wheel-manager/weekly-round's own `COMMIT_QUEUE`, copied verbatim (see
/// `create-your-own-luck::execute::PUSH_COMMITS_MAX_BATCH`'s sibling here).
pub const COMMIT_QUEUE: Deque<HexBinary> = Deque::new("commit_queue");
/// Every commit ever pushed via `PushCommits`, kept forever - prevents the
/// admin from accidentally pushing the same commit twice across batches
/// (mirrors wheel-manager's `USED_COMMITS` exactly).
pub const USED_COMMITS: Map<&[u8], Empty> = Map::new("used_commits");
/// raffle address -> the commit it currently holds, consumed via
/// `ConsumeCommit` and not yet returned via `ReturnCommit`. Doubles as the
/// dedup guard that stops a raffle from calling `ConsumeCommit` a second time
/// while already holding one, and is what `ReturnCommit` reads to know which
/// commit to hand back to the front of `COMMIT_QUEUE`.
pub const RAFFLE_COMMITS: Map<&Addr, HexBinary> = Map::new("raffle_commits");
