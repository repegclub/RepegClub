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

    #[error("This wallet is on cooldown for creating another small paid raffle - try again after {available_at} (unix seconds). Creating a safe-shaped raffle (free, or max_players large enough) in the meantime is fine, but does not shorten this cooldown")]
    CreatorOnCooldown { available_at: u64 },

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("base_bps + late_additional_bps must not exceed 10000 (100%)")]
    InvalidCancellationPenaltyBps {},

    #[error("commit_pusher must be a different wallet than admin - collapsing the two roles defeats the reason commit_pusher was split off admin in the first place")]
    CommitPusherMustDifferFromAdmin {},

    // --- v9: commit-reveal queue ---
    #[error("PushCommits requires 1 to {max} commits per batch")]
    InvalidCommitBatch { max: u32 },

    #[error("Every commit must be exactly 32 bytes")]
    InvalidCommitLength {},

    #[error("That commit has already been used - commits cannot be reused across batches")]
    CommitAlreadyUsed {},

    #[error("The commit queue is already at its maximum length ({max})")]
    CommitQueueFull { max: u32 },

    #[error("No commits available in the queue")]
    NoCommitsAvailable {},

    #[error("This raffle already consumed a commit and has not returned it")]
    CommitAlreadyConsumed {},

    #[error("This raffle has no unconsumed commit to return")]
    NoCommitToReturn {},
}
