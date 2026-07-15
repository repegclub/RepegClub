use cosmwasm_std::{
    entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Uint128,
};

use crate::error::ContractError;
use crate::execute::{
    execute_buy_ticket, execute_cancel_raffle, execute_claim_airdrop_share, execute_close_round,
    execute_deposit_prize, execute_draw_winner, execute_pay_service_fee, execute_reclaim_unclaimed,
    execute_receive,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, PrizeAsset, RaffleState, RaffleStatus, RaffleType, CONFIG, RAFFLE};

/// Hard ceiling on `podium_shares_bps.len()`. Without this, a raffle with an
/// unbounded number of places would do O(places x entrants) hashing and emit
/// one BankMsg::Send per place inside a single `DrawWinner` call - if that
/// ever exceeded the block gas limit, the raffle would be stuck `Closed`
/// forever (undrawable, and `CancelRaffle` is blocked once `Closed`).
const MAX_PODIUM_PLACES: u32 = 20;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.min_players < 2 || msg.max_players < msg.min_players {
        return Err(ContractError::InvalidPlayerBounds {});
    }
    if msg.raffle_type == RaffleType::Podium {
        let places = msg.podium_shares_bps.len() as u32;
        // Summed as u64 (not u32) so a crafted list of huge per-entry values
        // can never wrap around to a false-positive 10000 - correctness here
        // shouldn't depend on the `overflow-checks` release profile flag.
        let sum: u64 = msg.podium_shares_bps.iter().map(|bps| *bps as u64).sum();
        let has_zero_share = msg.podium_shares_bps.contains(&0);
        if places == 0 || places > MAX_PODIUM_PLACES || sum != 10_000 || has_zero_share {
            return Err(ContractError::InvalidPodiumShares {});
        }
        if msg.min_players < places {
            return Err(ContractError::PodiumNeedsMorePlayers { needed: places });
        }
    } else if !msg.podium_shares_bps.is_empty() {
        return Err(ContractError::PodiumSharesNotApplicable {});
    }

    let prize_asset = match (msg.prize_native_denom, msg.prize_cw20_address) {
        (Some(denom), None) => PrizeAsset::Native { denom },
        (None, Some(addr)) => PrizeAsset::Cw20 {
            address: deps.api.addr_validate(&addr)?,
        },
        _ => {
            return Err(ContractError::Std(StdError::generic_err(
                "exactly one of prize_native_denom or prize_cw20_address must be set",
            )))
        }
    };

    let allowed_entrants = msg
        .allowed_entrants
        .map(|list| {
            list.iter()
                .map(|a| deps.api.addr_validate(a))
                .collect::<StdResult<Vec<_>>>()
        })
        .transpose()?;

    let config = Config {
        creator: info.sender.clone(),
        raffle_type: msg.raffle_type,
        ticket_price: msg.ticket_price,
        ticket_denom: msg.ticket_denom,
        allowed_entrants,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_timeout_seconds: msg.round_timeout_seconds,
        draw_delay_blocks: msg.draw_delay_blocks,
        draw_window_blocks: msg.draw_window_blocks,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        prize_asset,
        fee_amount_usdc: msg.fee_amount_usdc,
        usdc_denom: msg.usdc_denom,
        founder_fee_address: deps.api.addr_validate(&msg.founder_fee_address)?,
        treasury_address: deps.api.addr_validate(&msg.treasury_address)?,
        podium_shares_bps: msg.podium_shares_bps,
    };
    CONFIG.save(deps.storage, &config)?;

    RAFFLE.save(
        deps.storage,
        &RaffleState {
            status: RaffleStatus::Funding,
            entrants: vec![],
            unique_players: vec![],
            ticket_revenue: Uint128::zero(),
            prize_amount: Uint128::zero(),
            fee_amount: Uint128::zero(),
            fee_paid: false,
            opened_at: None,
            closed_at: None,
            draw_after_height: None,
            drawn_at: None,
            winners: vec![],
            prize_shares: vec![],
            airdrop_share: Uint128::zero(),
            reclaimed: false,
        },
    )?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("creator", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::DepositPrize {} => execute_deposit_prize(deps, env, info),
        ExecuteMsg::PayServiceFee {} => execute_pay_service_fee(deps, info),
        ExecuteMsg::Receive(wrapper) => execute_receive(deps, env, info, wrapper),
        ExecuteMsg::BuyTicket {} => execute_buy_ticket(deps, env, info),
        ExecuteMsg::CloseRound {} => execute_close_round(deps, env),
        ExecuteMsg::DrawWinner {} => execute_draw_winner(deps, env),
        ExecuteMsg::ClaimAirdropShare {} => execute_claim_airdrop_share(deps, info),
        ExecuteMsg::ReclaimUnclaimed {} => execute_reclaim_unclaimed(deps, env, info),
        ExecuteMsg::CancelRaffle {} => execute_cancel_raffle(deps, info),
    }
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, env, msg)
}
