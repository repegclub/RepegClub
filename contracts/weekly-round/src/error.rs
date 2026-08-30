use cosmwasm_std::{StdError, Uint128};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Week is not open")]
    WeekNotOpen {},

    #[error("Week is not closed")]
    WeekNotClosed {},

    #[error("Week has not been drawn yet")]
    WeekNotDrawn {},

    #[error("Unexpected denom attached: {denom} - only send the denom(s) this call expects, or they'd sit unspent in the contract with no dedicated way to recover them")]
    UnexpectedFundsAttached { denom: String },

    #[error("Week cannot be closed yet: max players not reached and the round duration has not elapsed")]
    CannotCloseWeek {},

    #[error("Not enough players to draw a winner (minimum: {min_players})")]
    NotEnoughPlayers { min_players: u32 },

    #[error("Wrong ticket payment: expected exactly {expected}{denom}")]
    WrongTicketPayment { expected: Uint128, denom: String },

    #[error("No funds sent")]
    NoFundsSent {},

    #[error("Week not found: {week_id}")]
    WeekNotFound { week_id: u64 },

    #[error("This wallet is not the winner of week {week_id}")]
    NotWinner { week_id: u64 },

    #[error("Prize for week {week_id} has already been fully redeemed")]
    NothingToRedeem { week_id: u64 },

    #[error("min_players must be at least 2, and max_players must be >= min_players")]
    InvalidPlayerBounds {},

    #[error("The unclaimed-prize deadline has not passed yet for week {week_id}")]
    UnclaimedDeadlineNotReached { week_id: u64 },

    #[error("This wallet already holds the maximum of {max_per_wallet} tickets allowed for this week")]
    TicketCapExceeded { max_per_wallet: u32 },

    #[error("Week has expired without reaching the minimum number of players - buy a ticket in the next week, or reclaim your ticket from this one")]
    WeekExpired {},

    #[error("Week cannot be expired yet: either the minimum players was already reached, or round_duration_days has not elapsed")]
    CannotExpireWeek {},

    #[error("Week {week_id} has not expired")]
    WeekNotExpired { week_id: u64 },

    #[error("This wallet did not buy any tickets in week {week_id}")]
    NotAnEntrant { week_id: u64 },

    #[error("Nothing left to sweep for week {week_id}")]
    NothingToSweep { week_id: u64 },

    #[error("Week {week_id} already reached the minimum number of players - tickets can no longer be withdrawn")]
    WeekAlreadyLocked { week_id: u64 },

    // --- v9: commit-reveal + reveal queue + 3-phase expiration ---
    #[error("max_reveal_age_seconds must be between {min} and {max} seconds")]
    InvalidMaxRevealAgeSeconds { min: u64, max: u64 },

    #[error("This week does not have a commit assigned yet - wait for the operator to seed it")]
    WeekNotSeeded {},

    #[error("Week {week_id} already exists")]
    WeekAlreadyExists { week_id: u64 },

    #[error("There is nothing waiting to be revealed")]
    NothingToReveal {},

    #[error("Week {week_id} is not next in the reveal queue - the front of the queue is week {front}, resolve that one first")]
    QueueMismatch { front: u64, week_id: u64 },

    #[error("Week is not in a revealable state (must be Closed or ExpiryPending)")]
    WeekNotRevealable {},

    #[error("The provided preimage does not match this week's committed hash")]
    BadPreimage {},

    #[error("PushCommits requires 1 to {max} commits per batch")]
    InvalidCommitBatch { max: u32 },

    #[error("Every commit must be exactly 32 bytes")]
    InvalidCommitLength {},

    #[error("That commit has already been used - commits cannot be reused across batches")]
    CommitAlreadyUsed {},

    #[error("The commit queue is already at its maximum length ({max})")]
    CommitQueueFull { max: u32 },

    #[error("The current week already has a commit assigned")]
    CommitAlreadyAssigned {},

    #[error("AssignCommit only applies to the current week while it is Open with no entrants yet")]
    CannotAssignCommit {},

    #[error("No commits available in the queue")]
    NoCommitsAvailable {},

    #[error("Week {week_id} is not Closed")]
    WeekNotClosedForExpiry { week_id: u64 },

    #[error("Week {week_id}'s reveal is not overdue yet - max_reveal_age_seconds has not elapsed since it closed")]
    RevealNotYetOverdue { week_id: u64 },

    #[error("An expiration request for week {week_id} is already pending")]
    ExpireAlreadyRequested { week_id: u64 },

    #[error("No expiration request is pending for week {week_id}")]
    ExpireNotRequested { week_id: u64 },

    #[error("The expiration request for week {week_id} has expired - request it again")]
    ExpireRequestExpired { week_id: u64 },

    #[error("Week {week_id}'s expiration request has not cleared its finalize delay yet")]
    FinalizeDelayNotElapsed { week_id: u64 },

    #[error("Week {week_id} is not ExpiryPending")]
    WeekNotExpiryPending { week_id: u64 },

    #[error("Week {week_id}'s challenge window is still open - a legitimate reveal can still land")]
    ChallengeWindowOpen { week_id: u64 },
}
