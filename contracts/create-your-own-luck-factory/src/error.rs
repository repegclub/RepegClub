use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Raffle creation does not accept attached funds - fund the raffle separately (DepositPrize/PayServiceFee) once its address is known")]
    UnexpectedFundsAttached {},

    #[error("Unexpected reply id: {id}")]
    UnknownReplyId { id: u64 },

    #[error("Failed to parse the raffle's instantiate reply: {0}")]
    ReplyParse(String),

    #[error("This wallet is on cooldown for creating another small paid raffle - try again after {available_at} (unix seconds), or create a safe-shaped one (free, or max_players large enough) to reset it")]
    CreatorOnCooldown { available_at: u64 },
}
