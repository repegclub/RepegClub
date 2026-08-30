use cosmwasm_std::{StdError, Uint128};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Round is not open")]
    RoundNotOpen {},

    #[error("Round is not closed")]
    RoundNotClosed {},

    #[error("Round has not been drawn yet")]
    RoundNotDrawn {},

    #[error("Unexpected denom attached: {denom} - only send the denom(s) this call expects, or they'd sit unspent in the contract with no dedicated way to recover them")]
    UnexpectedFundsAttached { denom: String },

    #[error("Round cannot be closed yet: max players not reached and timeout has not elapsed")]
    CannotCloseRound {},

    #[error("Not enough players to draw a winner (minimum: {min_players})")]
    NotEnoughPlayers { min_players: u32 },

    #[error("Wrong ticket payment: expected exactly {expected}{denom}")]
    WrongTicketPayment { expected: Uint128, denom: String },

    #[error("No funds sent")]
    NoFundsSent {},

    #[error("Wrong redemption denom, expected {expected}")]
    WrongRedemptionDenom { expected: String },

    #[error("Round not found: {round_id}")]
    RoundNotFound { round_id: u64 },

    #[error("This wallet is not the winner of round {round_id}")]
    NotWinner { round_id: u64 },

    #[error("Prize for round {round_id} has already been fully redeemed")]
    NothingToRedeem { round_id: u64 },

    #[error("min_players must be at least 2, and max_players must be >= min_players")]
    InvalidPlayerBounds {},

    #[error("The unclaimed-prize deadline has not passed yet for round {round_id}")]
    UnclaimedDeadlineNotReached { round_id: u64 },

    #[error("This wallet already holds the maximum of {max_per_wallet} tickets allowed for this round")]
    TicketCapExceeded { max_per_wallet: u32 },

    #[error("Round has expired without reaching the minimum number of players - buy a ticket in the next round, or reclaim your ticket from this one")]
    RoundExpired {},

    #[error("Round cannot be expired yet: either the minimum players was already reached, or max_round_age_seconds has not elapsed")]
    CannotExpireRound {},

    #[error("Round {round_id} has not expired")]
    RoundNotExpired { round_id: u64 },

    #[error("This wallet did not buy any tickets in round {round_id}")]
    NotAnEntrant { round_id: u64 },

    #[error("Nothing left to sweep for round {round_id}")]
    NothingToSweep { round_id: u64 },

    #[error("Round {round_id} already reached the minimum number of players - tickets can no longer be withdrawn")]
    RoundAlreadyLocked { round_id: u64 },

    // --- v9: commit-reveal + reveal queue + 3-phase expiration ---
    #[error("max_reveal_age_seconds must be between {min} and {max} seconds")]
    InvalidMaxRevealAgeSeconds { min: u64, max: u64 },

    #[error("This round does not have a commit assigned yet - wait for the operator to seed it")]
    RoundNotSeeded {},

    #[error("Round {round_id} already exists")]
    RoundAlreadyExists { round_id: u64 },

    #[error("There is nothing waiting to be revealed")]
    NothingToReveal {},

    #[error("Round {round_id} is not next in the reveal queue - the front of the queue is round {front}, resolve that one first")]
    QueueMismatch { front: u64, round_id: u64 },

    #[error("Round is not in a revealable state (must be Closed or ExpiryPending)")]
    RoundNotRevealable {},

    #[error("The provided preimage does not match this round's committed hash")]
    BadPreimage {},

    #[error("PushCommits requires 1 to {max} commits per batch")]
    InvalidCommitBatch { max: u32 },

    #[error("Every commit must be exactly 32 bytes")]
    InvalidCommitLength {},

    #[error("That commit has already been used - commits cannot be reused across batches")]
    CommitAlreadyUsed {},

    #[error("The commit queue is already at its maximum length ({max})")]
    CommitQueueFull { max: u32 },

    #[error("The current round already has a commit assigned")]
    CommitAlreadyAssigned {},

    #[error("AssignCommit only applies to the current round while it is Open with no entrants yet")]
    CannotAssignCommit {},

    #[error("No commits available in the queue")]
    NoCommitsAvailable {},

    #[error("Round {round_id} is not Closed")]
    RoundNotClosedForExpiry { round_id: u64 },

    #[error("Round {round_id}'s reveal is not overdue yet - max_reveal_age_seconds has not elapsed since it closed")]
    RevealNotYetOverdue { round_id: u64 },

    #[error("An expiration request for round {round_id} is already pending")]
    ExpireAlreadyRequested { round_id: u64 },

    #[error("No expiration request is pending for round {round_id}")]
    ExpireNotRequested { round_id: u64 },

    #[error("The expiration request for round {round_id} has expired - request it again")]
    ExpireRequestExpired { round_id: u64 },

    #[error("Round {round_id}'s expiration request has not cleared its finalize delay yet")]
    FinalizeDelayNotElapsed { round_id: u64 },

    #[error("Round {round_id} is not ExpiryPending")]
    RoundNotExpiryPending { round_id: u64 },

    #[error("Round {round_id}'s challenge window is still open - a legitimate reveal can still land")]
    ChallengeWindowOpen { round_id: u64 },
}
