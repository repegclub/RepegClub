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
}
