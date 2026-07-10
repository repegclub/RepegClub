use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Winner already set")]
    WinnerAlreadySet {},

    #[error("Winner not set yet")]
    WinnerNotSet {},

    #[error("Already redeemed")]
    AlreadyRedeemed {},

    #[error("No funds sent")]
    NoFundsSent {},

    #[error("Wrong denom sent, expected {expected}")]
    WrongDenom { expected: String },
}
