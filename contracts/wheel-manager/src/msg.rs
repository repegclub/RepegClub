use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, HexBinary, Uint128};

use crate::state::RoundStatus;

#[cw_serde]
pub struct InstantiateMsg {
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub unclaimed_deadline_days: u64,
    pub max_round_age_seconds: u64,
    /// See `Config::max_reveal_age_seconds`'s own doc comment. Bounded at
    /// instantiate - see `contract::MIN_MAX_REVEAL_AGE_SECONDS`.
    pub max_reveal_age_seconds: u64,
    pub treasury_address: String,
    pub admin_fee_address: String,
    pub weekly_round_address: String,
    /// See `Config::commit_pusher`'s own doc comment. Must be a wallet
    /// distinct from both `admin` and whatever wallet runs the always-on
    /// keeper automation - see the project's Obsidian notes on why that
    /// separation matters (a compromised always-on process must never be
    /// able to seed its own future commits).
    pub commit_pusher: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    BuyTicket {},
    CloseRound {},
    /// Reveals the winner for the round at the front of the reveal queue
    /// (`round_id` must match it - see `REVEAL_QUEUE`'s doc comment).
    /// Permissionless: the result never depends on who calls this, only on
    /// knowing the correct `preimage` for that round's committed hash - and
    /// in practice only the admin (who generated it offline) ever does.
    /// Replaces the old block-hash-based `DrawWinner`.
    RevealDraw { round_id: u64, preimage: HexBinary },
    Redeem { round_id: u64 },
    SweepUstc {},
    /// Anyone can call this once `unclaimed_deadline_days` have passed since a
    /// round was drawn with an unredeemed prize - sends it to the treasury.
    /// No admin discretion involved, deliberately replacing an earlier
    /// `AdminReassignWinner` design that let the admin redirect a live prize
    /// to any address at any time (see security review, 2026-07-08). Also
    /// handles sweeping an `Expired` round's abandoned (unreclaimed) pool
    /// after the same deadline, measured from `expired_at` instead.
    SweepExpiredPrize { round_id: u64 },
    /// Permissionless. Marks the current round `Expired` if `min_players` was
    /// never reached and `max_round_age_seconds` has elapsed since it opened,
    /// then immediately opens the next round so the game isn't stuck. Ticket
    /// money stays in the expired round for `ReclaimTicket`; only the
    /// carried-in amount from the previous round's 5% cut (nobody's specific
    /// ticket money) rolls forward.
    ExpireRound {},
    /// Callable by any wallet that bought a ticket in an `Expired` round -
    /// refunds exactly what that wallet paid (ticket_price * their ticket
    /// count) and removes them from that round's entrant list.
    ReclaimTicket { round_id: u64 },
    /// Self-service refund for a wallet's own tickets in the current round,
    /// only while `min_players` hasn't been reached yet (once it has, the
    /// rolling close deadline is live and withdrawing would let a player
    /// watch the round develop then bail, which isn't allowed). Refunds
    /// exactly what that wallet paid and removes it from the round -
    /// deliberately no minimum wait before a second player shows up.
    WithdrawTicket { round_id: u64 },
    /// Restricted to `Config::commit_pusher` (round-review fix, CodeRabbit
    /// 2026-08-30 - this comment previously said "Admin-only", stale since
    /// that role split off `admin`). Adds pre-generated commits
    /// (`sha256(preimage)`, 32 bytes each, generated offline) to
    /// `COMMIT_QUEUE` - see that constant's doc comment for the dedup/reuse
    /// rules.
    PushCommits { commits: Vec<HexBinary> },
    /// Permissionless backfill: assigns the next queued commit to the current
    /// round if it doesn't have one yet (only possible while it's `Open` with
    /// no entrants - `BuyTicket` already refuses to sell before a commit is
    /// assigned, so this only matters if `COMMIT_QUEUE` was empty when the
    /// round opened).
    AssignCommit {},
    /// Permissionless. First step of the 3-phase expiration for a `Closed`
    /// round that has gone unrevealed for `max_reveal_age_seconds` - the
    /// outage safety net. Only marks intent; a legitimate `RevealDraw` is
    /// still fully valid after this.
    RequestExpireClosedRound { round_id: u64 },
    /// Permissionless. Second step - after the request has sat for
    /// `execute::EXPIRE_FINALIZE_DELAY_BLOCKS`, transitions the round to
    /// `ExpiryPending`. Still rescuable by a legitimate `RevealDraw`.
    FinalizeExpireClosedRound { round_id: u64 },
    /// Permissionless. Final step - after `ExpiryPending` has sat for
    /// `execute::EXPIRE_CHALLENGE_BLOCKS` with no reveal, refunds every
    /// entrant's ticket (never penalized - a no-fault outage safety net) and
    /// marks the round `Expired`.
    ClaimExpiredRound { round_id: u64 },
    /// Admin-only. Recovery action for a suspected/confirmed `commit_pusher`
    /// key compromise (round-review fix, Opus, commit_pusher audit round,
    /// 2026-08-30) - discards every commit still sitting in `COMMIT_QUEUE`
    /// unassigned. Only touches unassigned commits: never reassigns or
    /// changes `Round::commit_used` for any round that already has one
    /// (open, closed, or drawn), so it can't retroactively change the
    /// outcome of any round that already has entrants or has been revealed.
    /// Discarded commits stay in `USED_COMMITS` (never re-pushable) - the
    /// operator must generate and push a fresh batch afterward. Deliberately
    /// `admin`-only, not `commit_pusher`-only: the scenario this exists for
    /// is precisely "the commit_pusher key is compromised", so the pusher
    /// itself must not be able to call this.
    DiscardQueuedCommits {},
    /// Admin-only. Rotates `Config::commit_pusher` to a new wallet - the
    /// other half of recovering from a suspected/confirmed key compromise
    /// (pair with `DiscardQueuedCommits` above). Must differ from `admin`,
    /// same invariant enforced at instantiate.
    SetCommitPusher { commit_pusher: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(RoundResponse)]
    GetCurrentRound {},
    #[returns(RoundResponse)]
    GetRoundHistory { round_id: u64 },
    #[returns(MyWinningsResponse)]
    GetMyWinnings { wallet: String },
    #[returns(ConfigResponse)]
    GetConfig {},
    /// Full per-ticket entrant list for a round (one entry per ticket,
    /// duplicates for wallets that bought more than one) - not included in
    /// `RoundResponse` itself since most callers only need the aggregate
    /// counts already there. Needed by frontends that render the wheel's
    /// per-wallet segments.
    #[returns(EntrantsResponse)]
    GetRoundEntrants { round_id: u64 },
    /// Lifetime per-wallet totals, for the frontend's "how much have I
    /// invested" / "how much USTC have I actually repegged" display.
    #[returns(WalletStatsResponse)]
    GetWalletStats { wallet: String },
}

#[cw_serde]
pub struct RoundResponse {
    pub round_id: u64,
    pub status: RoundStatus,
    pub ticket_count: u64,
    pub unique_player_count: u64,
    pub pool: Uint128,
    pub opened_at: u64,
    /// Rolling close deadline (unix seconds) - unset until min_players is
    /// reached, then pushed forward on every ticket purchase. Lets a
    /// frontend show a live countdown to when CloseRound becomes callable.
    pub deadline: Option<u64>,
    pub closed_at: Option<u64>,
    pub closed_at_height: Option<u64>,
    pub drawn_at: Option<u64>,
    /// The hash this round must be revealed against - lets anyone confirm
    /// `revealed_preimage` (once set) actually satisfies it before trusting
    /// `winner`.
    pub commit_used: Option<HexBinary>,
    /// The secret that unlocked `commit_used`, once revealed - lets anyone
    /// independently recompute `pick_winner_index(contract_addr, round_id,
    /// revealed_preimage, entrants)` and check it against `winner`.
    pub revealed_preimage: Option<HexBinary>,
    pub winner: Option<Addr>,
    pub prize_remaining: Uint128,
    pub expired_at: Option<u64>,
}

#[cw_serde]
pub struct WinningEntry {
    pub round_id: u64,
    pub prize_remaining: Uint128,
}

#[cw_serde]
pub struct MyWinningsResponse {
    pub winnings: Vec<WinningEntry>,
}

#[cw_serde]
pub struct EntrantsResponse {
    pub entrants: Vec<Addr>,
}

#[cw_serde]
pub struct WalletStatsResponse {
    pub total_invested: Uint128,
    pub total_redeemed: Uint128,
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: Addr,
    pub ticket_price: Uint128,
    pub ticket_denom: String,
    pub redemption_denom: String,
    pub min_players: u32,
    pub max_players: u32,
    pub round_timeout_seconds: u64,
    pub unclaimed_deadline_days: u64,
    pub max_round_age_seconds: u64,
    pub max_reveal_age_seconds: u64,
    pub treasury_address: Addr,
    pub admin_fee_address: Addr,
    pub weekly_round_address: Addr,
    pub commit_pusher: Addr,
}
