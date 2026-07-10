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

    #[error("Week cannot be closed yet: max players not reached and the round duration has not elapsed")]
    CannotCloseWeek {},

    #[error("Week cannot be drawn yet: must wait until block {required_height}")]
    DrawTooEarly { required_height: u64 },

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
}
