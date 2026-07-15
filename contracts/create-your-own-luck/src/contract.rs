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

/// Hard ceiling on `podium_shares_bps.len()`. Two reasons: (1) gas safety -
/// without this, a raffle with an unbounded number of places would do
/// O(places x entrants) hashing and emit one BankMsg::Send per place inside a
/// single `DrawWinner` call, and if that ever exceeded the block gas limit
/// the raffle would be stuck `Closed` forever (undrawable, and
/// `CancelRaffle` is blocked once `Closed`); (2) product clarity - "Podium"
/// is meant to be a handful of ranked prize tiers, distinct from `Airdrop`
/// (equal split across every player). A high place count would blur that
/// line into a disguised, cheaper Airdrop.
const MAX_PODIUM_PLACES: u32 = 10;

/// Flat service fee (USDC micros) for SingleWinner and Podium raffles.
const FLAT_FEE_USDC: u128 = 3_000_000; // "$3"

/// Volume-discount commission schedule for Airdrop raffles, keyed by
/// `max_players` ceiling (ascending, USDC micros). Discount is a growth
/// incentive, not cost-recovery - each participant pays their own claim gas,
/// so the platform's per-participant cost doesn't scale linearly. Confirmed
/// with the user 2026-07-15 (see docs/rueda-del-repeg-diseno.html §09, which
/// had these as examples pending confirmation).
const AIRDROP_FEE_TIERS_USDC: [(u32, u128); 4] = [
    (100, 3_000_000),   // "$3"
    (300, 7_000_000),   // "$7"
    (600, 12_000_000),  // "$12"
    (1000, 18_000_000), // "$18"
];

/// Platform fee-recipient addresses, hardcoded (not creator-supplied) so a
/// raffle creator can never redirect the service fee to their own wallet.
/// Same addresses used platform-wide for Wheel Manager/Weekly Round's
/// admin_fee_address/treasury_address (see scripts/testnet/src/config.ts) -
/// one founder-fee wallet for the whole platform, not one per product.
/// Testnet values today; swap for the real mainnet addresses (and
/// USDC_DENOM below) in the final production redeploy, same as every other
/// contract in this project.
const FOUNDER_FEE_ADDRESS: &str = "terra15dv0f2rykyp6gyvuhawk8qgfd7ypm4lgkm4z39";
const TREASURY_ADDRESS: &str = "terra1juzyema7r4gvrrvrkkznceyeyhfkdj6zvz20fd";
/// Hardcoded for the same reason - a creator-chosen denom could be a
/// worthless token dressed up as "USDC", satisfying the fee amount check
/// without paying anything of real value.
const USDC_DENOM: &str = "utestusdc";

/// Computes the required service fee on-chain from `raffle_type` (and, for
/// Airdrop, `max_players`) instead of trusting a creator-supplied amount -
/// closes off a creator quietly setting their own fee to near-zero.
fn required_fee_usdc(raffle_type: RaffleType, max_players: u32) -> Result<Uint128, ContractError> {
    match raffle_type {
        RaffleType::SingleWinner | RaffleType::Podium => Ok(Uint128::new(FLAT_FEE_USDC)),
        RaffleType::Airdrop => AIRDROP_FEE_TIERS_USDC
            .iter()
            .find(|(cap, _)| max_players <= *cap)
            .map(|(_, fee)| Uint128::new(*fee))
            .ok_or(ContractError::MaxPlayersExceedsAirdropFeeTiers {}),
    }
}

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

    let fee_amount_usdc = required_fee_usdc(msg.raffle_type, msg.max_players)?;

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
        fee_amount_usdc,
        usdc_denom: USDC_DENOM.to_string(),
        founder_fee_address: deps.api.addr_validate(FOUNDER_FEE_ADDRESS)?,
        treasury_address: deps.api.addr_validate(TREASURY_ADDRESS)?,
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
