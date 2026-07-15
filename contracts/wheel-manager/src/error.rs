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

    #[error("Round cannot be closed yet: max players not reached and timeout has not elapsed")]
    CannotCloseRound {},

    #[error("Round cannot be drawn yet: must wait until block {required_height}")]
    DrawTooEarly { required_height: u64 },

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
}
