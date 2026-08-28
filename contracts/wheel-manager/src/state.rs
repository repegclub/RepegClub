use cosmwasm_std::{Addr, Empty, HexBinary, Timestamp, Uint128};
use cw_storage_plus::{Deque, Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Config {
    pub admin: Addr,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    /// Days after a round is drawn before an unredeemed prize can be swept to
    /// the treasury by anyone via `SweepExpiredPrize` (no admin discretion
    /// involved - a fixed, automatic deadline).
    pub unclaimed_deadline_days: u64,
    /// Hard ceiling, in seconds since a round opened, on how long it can stay
    /// Open - independent of the rolling soft-close `deadline`. Serves two
    /// purposes: (1) if `min_players` is never reached, it's when
    /// `ExpireRound` becomes callable so buyers can reclaim their tickets
    /// instead of funds being stuck forever; (2) if `min_players` was reached
    /// but the rolling deadline keeps getting pushed forward by new tickets,
    /// it caps how long that extension can go on before `CloseRound` is
    /// forced regardless.
    pub max_round_age_seconds: u64,
    /// How long, in seconds since `closed_at`, a `Closed` round can wait for
    /// a legitimate `RevealDraw` before `RequestExpireClosedRound` becomes
    /// callable - the outage safety net described in `execute::EXPIRE_*`
    /// docs. Bounded at `instantiate` (see `contract::MIN_MAX_REVEAL_AGE_SECONDS`)
    /// for the same reason every other timing field here is: an unbounded or
    /// zero value would either reopen the cheap version of the mempool
    /// front-run risk (see the project's Obsidian notes on the grinding
    /// finding) or make this contract's normal operation resemble an outage.
    pub max_reveal_age_seconds: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
    pub weekly_round_address: Addr,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RoundStatus {
    Open,
    Closed,
    /// A `RequestExpireClosedRound` → `FinalizeExpireClosedRound` pair has
    /// run for this round (only reachable once it's been `Closed` without a
    /// reveal for `max_reveal_age_seconds`). A legitimate `RevealDraw` can
    /// still rescue it from here; if nobody does within
    /// `execute::EXPIRE_CHALLENGE_BLOCKS`, `ClaimExpiredRound` resolves it to
    /// `Expired` instead.
    ExpiryPending,
    Drawn,
    /// Never reached `min_players` before `max_round_age_seconds` elapsed, OR
    /// reached `Closed` but nobody ever revealed it in time (see
    /// `ExpiryPending`) - terminal either way, resolved via `ReclaimTicket`
    /// instead of `Redeem` since there's no winner, just buyers getting their
    /// own money back.
    Expired,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Round {
    pub round_id: u64,
    pub status: RoundStatus,
    pub entrants: Vec<Addr>,
    pub unique_players: Vec<Addr>,
    pub pool: Uint128,
    pub opened_at: Timestamp,
    /// Rolling close deadline - unset until `min_players` is reached, then
    /// pushed forward by `round_timeout_seconds` on every ticket purchase
    /// from then on (an auction-style "soft close" extension, not a fixed
    /// timer from `opened_at`). `CloseRound` becomes callable once this
    /// passes with nobody having bought a ticket in the meantime.
    pub deadline: Option<Timestamp>,
    pub closed_at: Option<Timestamp>,
    /// Block height at the moment this round closed. Deliberately NOT used
    /// as an input to the winner-picking hash (see `rand::pick_winner_index`);
    /// only `commit_used`'s preimage is. Kept for the expiration clock and
    /// for public verification, so anyone can independently confirm
    /// `closed_at`/`closed_at_height` are consistent with the chain.
    pub closed_at_height: Option<u64>,
    /// The commit (`sha256(preimage)`) this round must be revealed against.
    /// Assigned when the round opens, from `execute::COMMIT_QUEUE` (or left
    /// `None` if the queue was empty at that moment - see
    /// `execute::execute_assign_commit` for the permissionless backfill).
    /// `BuyTicket` refuses to sell a single ticket while this is `None`
    /// (`RoundNotSeeded`), so a round with any entrant always has a commit.
    pub commit_used: Option<HexBinary>,
    /// The preimage that satisfied `commit_used`, once revealed - exposed so
    /// anyone can recompute `sha256(preimage) == commit_used` and
    /// `pick_winner_index(...)` themselves (same public-verification story
    /// this project already built for the block-hash mechanism it replaces).
    pub revealed_preimage: Option<HexBinary>,
    /// Set by `RequestExpireClosedRound`; cleared the moment a legitimate
    /// `RevealDraw` rescues the round. See `execute::REQUEST_EXPIRE_TTL_BLOCKS`.
    pub expire_requested_at_height: Option<u64>,
    /// Set by `FinalizeExpireClosedRound`, when the round transitions to
    /// `ExpiryPending`. See `execute::EXPIRE_CHALLENGE_BLOCKS`.
    pub expiry_pending_since_height: Option<u64>,
    pub drawn_at: Option<Timestamp>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
    /// Set when the round transitions to `Expired`, from either terminal
    /// path (never reached `min_players`, or `Closed` and never revealed in
    /// time). Required for `SweepExpiredPrize` to ever become callable on
    /// this round - see that function's own `expired_at.ok_or(...)`.
    pub expired_at: Option<Timestamp>,
}

/// Global, non-round-scoped state: which round is currently active, and how
/// much unrouted carry (the 5% "next round" cut, or a stale-round refund's
/// leftover carry-in) is waiting for a currently-`Open` round to land in.
/// See `execute::route_carry` - under normal operation this is drained to
/// zero in the same transaction it's added to, since closing a round always
/// opens its successor atomically (this field only persists across
/// transactions in a state that shouldn't be reachable in practice; see that
/// function's own doc comment for why it's kept as defense in depth anyway).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct GlobalState {
    pub current_round_id: u64,
    pub next_round_carry: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const STATE: Item<GlobalState> = Item::new("state");
pub const ROUNDS: Map<u64, Round> = Map::new("rounds");
/// FIFO of `round_id`s waiting to be resolved (`RevealDraw` or the
/// expire-then-`ClaimExpiredRound` path) - populated only on `Open → Closed`
/// (never on `Open → Expired`, a different terminal path that never needed a
/// commit reveal to begin with). Consumed strictly from the front: both
/// `execute_reveal_draw` and `claim_expired_round` require the `round_id`
/// they're called with to match `REVEAL_QUEUE.front()`, rejecting otherwise.
/// Without that check, resolving a round out of order desyncs the queue and
/// can permanently stall every round after it - the Ronda 9 audit finding
/// (confirmed independently by two auditors) this guards against.
pub const REVEAL_QUEUE: Deque<u64> = Deque::new("reveal_queue");
/// Commits (`sha256(preimage)`, 32 bytes each) generated offline by the admin
/// and pushed in batches via `PushCommits` - each one gets assigned to
/// exactly one round when it opens (`execute::open_new_round`) or via the
/// permissionless backfill (`AssignCommit`). Independent commits, not a hash
/// chain - simpler to reason about and lets `PushCommits`/rotation happen
/// without any risk of an exhausted-chain edge case.
pub const COMMIT_QUEUE: Deque<HexBinary> = Deque::new("commit_queue");
/// Every commit ever pushed via `PushCommits`, for two purposes: (1) reject
/// a duplicate commit value in a later `PushCommits` batch (reusing a commit
/// would mean the same secret has to satisfy two different rounds - revealing
/// the first would leak the secret for the second, still-pending one); (2)
/// prevent it being pushed a second time even after its round resolved.
/// Monotonically growing, no pruning possible (see the project's Obsidian
/// notes for the accepted, small, storage-growth tradeoff this implies).
pub const USED_COMMITS: Map<&[u8], Empty> = Map::new("used_commits");
/// wallet -> round_ids where that wallet is the winner and prize_remaining > 0.
pub const WINNER_INDEX: Map<Addr, Vec<u64>> = Map::new("winner_index");
/// wallet -> lifetime ticket spend across every round, net of any
/// `WithdrawTicket` refunds (money withdrawn was never really at stake, so it
/// doesn't count as "invested"). Purely informational, read by
/// `GetWalletStats` for the frontend's "how much have I put in" display.
pub const TOTAL_INVESTED: Map<Addr, Uint128> = Map::new("total_invested");
/// wallet -> lifetime amount actually applied to a prize via `Redeem` (the
/// real payout, not any overpayment that got refunded back). Not derivable
/// from `WINNER_INDEX` alone, since a fully-redeemed entry is removed from it.
pub const TOTAL_REDEEMED: Map<Addr, Uint128> = Map::new("total_redeemed");
