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

    #[error("This raffle type supports at most 1000 max_players (see the free-raffle fee tier schedule)")]
    MaxPlayersExceedsFreeRaffleFeeTiers {},

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

    #[error("This wallet already has an airdrop claim in flight - wait for it to confirm before retrying")]
    ClaimAlreadyInFlight {},

    #[error("At least one airdrop claim is still in flight (dispatched, not yet confirmed) - wait for it to resolve before reclaiming unclaimed funds")]
    ClaimsStillInFlight {},

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

    #[error("Paid raffles (ticket_price > 0) can only offer LUNC, USDC, USTC, or a CW20 the platform has reviewed and whitelisted - contact the platform to get a new CW20 reviewed")]
    PrizeAssetNotAllowlisted {},

    #[error("This CW20 has been blocked as a raffle prize after repeated prize-transfer failures - contact the platform if you believe this is a mistake")]
    PrizeAssetBlacklisted {},

    #[error("This raffle's prize can no longer be paid out - it was blocked after 3 consecutive transfer failures against the prize token. If the platform clears the token on the factory's CW20 blacklist, this unblocks automatically")]
    PrizeBlocked {},

    #[error("Unexpected reply id: {id}")]
    UnknownReplyId { id: u64 },

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

    #[error("Paid raffles (ticket_price > 0) must set ticket_denom to the platform's USDC - otherwise the ticket price can't be compared in real dollar terms (needed for the fee calculation, and to avoid a cheap-looking ticket priced in a near-worthless denom)")]
    PaidTicketMustBeUsdc {},

    #[error("ticket_price is too high to compute the service fee (potential revenue overflows)")]
    FeeCalculationOverflow {},

    #[error("This wallet has no tickets to withdraw in this raffle")]
    NoTicketsToWithdraw {},

    #[error("Tickets can only be withdrawn before min_players is reached")]
    RaffleAlreadyLocked {},

    #[error("Raffle cannot be expired yet: either min_players was already reached, or the raffle's 60-day maximum age hasn't elapsed")]
    CannotExpireRaffle {},

    #[error("ticket_price must be either exactly 0 (free) or at least {min} USDC micros ($1) - no dust pricing in between")]
    TicketPriceBelowMinimum { min: u128 },

    #[error("ticket_price must be a whole number of USDC cents ({cent} micros) - fractional-cent pricing isn't a real price point")]
    TicketPriceNotWholeCents { cent: u128 },

    #[error("Every winner's prize share has already been confirmed paid - nothing to retry")]
    NothingToRetry {},
}
