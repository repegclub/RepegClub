use cosmwasm_std::{StdError, Uint128};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("This wallet is not in the allowlist for this raffle")]
    NotAllowed {},

    #[error("Podium raffles need min_players >= the number of podium places ({needed})")]
    PodiumNeedsMorePlayers { needed: u32 },

    #[error("podium_shares_bps must be non-empty and sum to exactly 10000 (100%)")]
    InvalidPodiumShares {},

    #[error("podium_shares_bps must be empty for non-Podium raffle types")]
    PodiumSharesNotApplicable {},

    #[error("Airdrop raffles support at most 1000 max_players (see the fee tier schedule)")]
    MaxPlayersExceedsAirdropFeeTiers {},

    #[error("SingleWinner and Podium raffles support at most {max} max_players")]
    MaxPlayersTooHighForRaffleType { max: u32 },

    #[error("Raffle is still waiting for DepositPrize")]
    StillFunding {},

    #[error("Prize has already been deposited")]
    AlreadyFunded {},

    #[error("Prize amount must be greater than zero")]
    ZeroPrize {},

    #[error("Wrong fee payment: expected exactly {expected}{denom}")]
    WrongFeePayment { expected: Uint128, denom: String },

    #[error("Raffle is not open")]
    RaffleNotOpen {},

    #[error("Raffle is not closed")]
    RaffleNotClosed {},

    #[error("Raffle has not been drawn yet")]
    RaffleNotDrawn {},

    #[error("This raffle has already been cancelled")]
    AlreadyCancelled {},

    #[error("Raffle cannot be cancelled once it is closed or drawn")]
    CannotCancel {},

    #[error("Raffle cannot be closed yet: max players not reached and timeout has not elapsed")]
    CannotCloseRound {},

    #[error("Raffle cannot be drawn yet: must wait until block {required_height}")]
    DrawTooEarly { required_height: u64 },

    #[error("Not enough players to draw a winner (minimum: {min_players})")]
    NotEnoughPlayers { min_players: u32 },

    #[error("Wrong ticket payment: expected exactly {expected}{denom}")]
    WrongTicketPayment { expected: Uint128, denom: String },

    #[error("No funds sent")]
    NoFundsSent {},

    #[error("This action is only for Airdrop raffles")]
    NotAirdrop {},

    #[error("This action is not valid for Airdrop raffles")]
    IsAirdrop {},

    #[error("This wallet did not participate in this raffle")]
    NotAParticipant {},

    #[error("This wallet already claimed its airdrop share")]
    AlreadyClaimed {},

    #[error("The unclaimed-funds deadline has not passed yet")]
    UnclaimedDeadlineNotReached {},

    #[error("The creator already reclaimed unclaimed funds for this raffle")]
    AlreadyReclaimed {},

    #[error("min_players must be at least 2, and max_players must be >= min_players")]
    InvalidPlayerBounds {},

    #[error("unclaimed_deadline_days must be between {min} and {max}")]
    InvalidUnclaimedDeadlineDays { min: u64, max: u64 },

    #[error("round_timeout_seconds must be between {min} and {max}")]
    InvalidRoundTimeoutSeconds { min: u64, max: u64 },

    #[error("draw_delay_blocks must be between {min} and {max}")]
    InvalidDrawDelayBlocks { min: u64, max: u64 },

    #[error("draw_window_blocks must be between {min} and {max}")]
    InvalidDrawWindowBlocks { min: u64, max: u64 },

    #[error("Paid raffles (ticket_price > 0) can only offer LUNC, USDC, or USTC as the prize - no CW20 tokens and no other native denoms yet. Free raffles (ticket_price = 0) have no restriction. Contact the platform to get a new asset reviewed and allowlisted")]
    PrizeAssetNotAllowlisted {},

    #[error("This raffle's prize is a CW20 token - use the CW20 token's Send instead of DepositPrize")]
    PrizeIsCw20 {},

    #[error("This raffle's prize is a native token - use DepositPrize instead of a CW20 Send")]
    PrizeIsNative {},

    #[error("Call PayServiceFee first: the prize denom matches the USDC fee denom (or the prize is CW20), so they can't be combined in a single call")]
    MustPayServiceFeeSeparately {},

    #[error("This wallet already holds the maximum of {max_per_wallet} tickets allowed for this raffle")]
    TicketCapExceeded { max_per_wallet: u32 },

    #[error("Unexpected denom attached: {denom} - only send the denom(s) this call expects, or they'd be stuck in the contract with no way to recover them")]
    UnexpectedFundsAttached { denom: String },
}
