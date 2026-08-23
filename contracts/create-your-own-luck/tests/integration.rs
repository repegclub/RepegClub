use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{
    coin, coins, from_json, to_json_binary, ContractResult, CosmosMsg, Reply, ReplyOn, SubMsgResponse,
    SubMsgResult, SystemError, SystemResult, Uint128, WasmMsg, WasmQuery,
};
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};

use create_your_own_luck::contract::{execute, instantiate, query, reply};
use create_your_own_luck::factory_msgs::{CancellationPenaltyResponse, FactoryQueryMsg};
use create_your_own_luck::msg::{
    ConfigResponse, Cw20HookMsg, EntrantsResponse, ExecuteMsg, InstantiateMsg,
    MyAirdropShareResponse, QueryMsg, RaffleStatusResponse, WinnersResponse,
};
use create_your_own_luck::state::{RaffleStatus, RaffleType};
use create_your_own_luck::ContractError;

/// Paid raffles must denominate the ticket in USDC (2026-07-21) - same
/// constant as the fee denom below, not a coincidence.
const TICKET_DENOM: &str = USDC_DENOM;
// USTC (uusd), deliberately distinct from USDC_DENOM below - most tests use
// the "combined single DepositPrize call" convenience path, which only works
// when the prize denom differs from the fee denom. Was "uluna" (LUNC) until
// 2026-07-23, when USDC_DENOM itself became "uluna" too (see that constant's
// comment in contract.rs) - kept distinct here on purpose so this suite still
// exercises both funding paths, not just the same-denom one.
const PRIZE_DENOM: &str = "uusd";
const USDC_DENOM: &str = "uluna"; // must match the hardcoded USDC_DENOM constant in contract.rs
const FEE_AMOUNT_USDC: u128 = 3_000_000; // "$3", charged directly - no oracle conversion anymore
/// Stand-in `create-your-own-luck-factory` address - every `InstantiateMsg`
/// in this suite points at it, and `mock_deps_with_factory` below answers
/// its whitelist/blacklist/cancellation-penalty queries (2026-08-20 CW20
/// whitelist/blacklist + cancellation-penalty redesign).
const FACTORY_ADDRESS: &str = "factory";
/// Real platform defaults (confirmed with the user, 2026-08-20) - see
/// create-your-own-luck-factory's own `DEFAULT_CANCELLATION_PENALTY_*_BPS`.
const CANCELLATION_PENALTY_BASE_BPS: u64 = 2_000;
const CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS: u64 = 8_000;

type Deps = cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>;

/// `mock_dependencies()` plus a `WasmQuery::Smart` handler standing in for
/// `FACTORY_ADDRESS` - every raffle instantiate (SingleWinner/Podium always,
/// Airdrop never) queries `GetCancellationPenaltyBps`, and any CW20 prize
/// queries `IsCw20Blacklisted` (always) / `IsCw20Whitelisted` (paid only) -
/// both at instantiate and again at CW20 deposit time. Defaults: nothing is
/// whitelisted or blacklisted (an arbitrary, unreviewed CW20 in a paid
/// raffle is correctly rejected, matching the real "admin review required"
/// behavior - see `instantiate_rejects_cw20_prize_for_a_paid_raffle`), and
/// the penalty is the real platform default.
fn mock_deps_with_factory() -> Deps {
    let mut deps = mock_dependencies();
    deps.querier.update_wasm(|query| match query {
        WasmQuery::Smart { contract_addr, msg } if contract_addr == FACTORY_ADDRESS => {
            let parsed: FactoryQueryMsg = from_json(msg).unwrap();
            let bin = match parsed {
                FactoryQueryMsg::IsCw20Whitelisted { .. } => to_json_binary(&false).unwrap(),
                FactoryQueryMsg::IsCw20Blacklisted { .. } => to_json_binary(&false).unwrap(),
                FactoryQueryMsg::GetCancellationPenaltyBps {} => to_json_binary(&CancellationPenaltyResponse {
                    base_bps: CANCELLATION_PENALTY_BASE_BPS,
                    late_additional_bps: CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS,
                })
                .unwrap(),
            };
            SystemResult::Ok(ContractResult::Ok(bin))
        }
        WasmQuery::Smart { contract_addr, .. } => {
            SystemResult::Err(SystemError::NoSuchContract { addr: contract_addr.clone() })
        }
        other => SystemResult::Err(SystemError::UnsupportedRequest {
            kind: format!("unmocked wasm query: {other:?}"),
        }),
    });
    deps
}

fn setup(
    raffle_type: RaffleType,
    min_players: u32,
    max_players: u32,
    ticket_price: u128,
    podium_shares_bps: Vec<u32>,
) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type,
        ticket_price: Uint128::new(ticket_price),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players,
        max_players,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps,
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    (deps, env)
}

fn deposit_prize(deps: &mut Deps, env: &cosmwasm_std::Env, prize_amount: u128, fee_sent: u128) -> Result<cosmwasm_std::Response, ContractError> {
    let mut funds = coins(prize_amount, PRIZE_DENOM);
    funds.push(cosmwasm_std::coin(fee_sent, USDC_DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &funds),
        ExecuteMsg::DepositPrize {},
    )
}

fn buy_ticket(deps: &mut Deps, env: &cosmwasm_std::Env, sender: &str, price: u128) -> Result<cosmwasm_std::Response, ContractError> {
    let funds = if price > 0 { coins(price, TICKET_DENOM) } else { vec![] };
    execute(deps.as_mut(), env.clone(), mock_info(sender, &funds), ExecuteMsg::BuyTicket {})
}

fn raffle_status(deps: &Deps, env: &cosmwasm_std::Env) -> RaffleStatusResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetRaffleStatus {}).unwrap();
    from_json(bin).unwrap()
}

/// Simulates the chain resolving a dispatched prize-transfer `SubMsg`'s
/// reply - needed for every test exercising the 2026-08-20 audit fix (the
/// payout/claim isn't finalized until this runs, unlike the pre-fix code
/// which finalized it before dispatch).
fn simulate_reply(deps: &mut Deps, env: &cosmwasm_std::Env, id: u64, ok: bool) -> cosmwasm_std::Response {
    let result = if ok {
        SubMsgResult::Ok(SubMsgResponse { events: vec![], data: None })
    } else {
        SubMsgResult::Err("mock prize transfer failure".to_string())
    };
    reply(deps.as_mut(), env.clone(), Reply { id, result }).unwrap()
}

#[test]
fn podium_needs_min_players_covering_all_places() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![5000, 3000, 2000], // 3 places, but min_players is only 2
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PodiumNeedsMorePlayers { needed: 3 }));
}

#[test]
fn podium_shares_must_sum_to_10000() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 3,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![5000, 3000, 1000], // sums to 9000, not 10000
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPodiumShares {}));
}

#[test]
fn podium_shares_reject_a_zero_percent_place() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![10_000, 0], // sums to 10000, but a 0% "winner" is deceptive
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPodiumShares {}));
}

#[test]
fn podium_shares_reject_too_many_places() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    // 11 places (1 more than MAX_PODIUM_PLACES), summing to exactly 10000 so
    // the place-count cap is the only reason this is rejected.
    let mut too_many = vec![910u32; 10];
    too_many.push(900);
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 11,
        max_players: 15,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: too_many,
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPodiumShares {}));
}

#[test]
fn podium_shares_rejected_for_non_podium_raffle() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![10_000], // not applicable - raffle_type isn't Podium
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PodiumSharesNotApplicable {}));
}

#[test]
fn airdrop_fee_scales_by_max_players_tier() {
    let cases = [
        (100u32, 3_000_000u128),
        (300, 7_000_000),
        (600, 12_000_000),
        (1000, 18_000_000),
    ];
    for (max_players, expected_fee) in cases {
        let (deps, env) = setup(RaffleType::Airdrop, 2, max_players, 0, vec![]);
        let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
        let config: ConfigResponse = from_json(bin).unwrap();
        assert_eq!(
            config.fee_amount_usdc,
            Uint128::new(expected_fee),
            "max_players={max_players} should charge {expected_fee}"
        );
    }
}

#[test]
fn airdrop_rejects_max_players_over_1000_for_free_raffles() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::Airdrop,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 1001,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    // MAX_PLAYERS_AIRDROP is checked unconditionally, before required_fee_usdc
    // ever runs - MaxPlayersExceedsFreeRaffleFeeTiers is consequently
    // unreachable in practice (same situation as SingleWinner/Podium's tier
    // always landing in-range), which is exactly the point: this cap must
    // not depend on which fee branch a raffle takes.
    assert!(matches!(err, ContractError::MaxPlayersTooHighForRaffleType { max: 1000 }));
}

#[test]
fn single_winner_and_podium_reject_max_players_over_100() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 101,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::MaxPlayersTooHighForRaffleType { max: 100 }));

    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 3,
        max_players: 101,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![5000, 3000, 2000],
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::MaxPlayersTooHighForRaffleType { max: 100 }));
}

#[test]
fn free_single_winner_and_podium_always_land_in_the_first_free_fee_tier() {
    // Free-raffle fee is judged by max_players via FREE_RAFFLE_FEE_TIERS_USDC
    // (paid raffles use the revenue-based % formula instead - see the
    // fee-scaling tests below). 100 is the max max_players allowed for these
    // two raffle types (see MAX_PLAYERS_SINGLE_WINNER_PODIUM), which is
    // exactly the first tier's ceiling - so free SingleWinner/Podium raffles
    // always pay that tier's $3, never more, unlike Airdrop which can reach
    // higher tiers at up to 1000 max_players.
    let (deps, env) = setup(RaffleType::SingleWinner, 2, 100, 0, vec![]);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.fee_amount_usdc, Uint128::new(FEE_AMOUNT_USDC));

    let (deps, env) = setup(RaffleType::Podium, 10, 100, 0, vec![5000, 3000, 2000]);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.fee_amount_usdc, Uint128::new(FEE_AMOUNT_USDC));
}

#[test]
fn deposit_prize_charges_the_fixed_usdc_fee_and_refunds_overpayment() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 0, vec![]);

    let err = deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC - 1).unwrap_err();
    assert!(matches!(err, ContractError::WrongFeePayment { .. }));

    let res = deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC + 500).unwrap();
    assert_eq!(res.messages.len(), 1); // refund of the 500 overpayment
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "creator");
        assert_eq!(amount, &coins(500, USDC_DENOM));
    } else {
        panic!("expected a refund BankMsg::Send");
    }

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Open);
    assert_eq!(status.prize_amount, Uint128::new(1000));
}

#[test]
fn only_creator_can_deposit_prize_and_only_once() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 0, vec![]);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("not-creator", &coins(1000, PRIZE_DENOM)),
        ExecuteMsg::DepositPrize {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    let err = deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap_err();
    assert!(matches!(err, ContractError::AlreadyFunded {}));
}

#[test]
fn free_ticket_raffle_lets_anyone_enter_without_funds() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let res = buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "true"));

    // Selling out draws immediately, in the same transaction as the closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Drawn);
    assert_eq!(status.unique_player_count, 2);
}

#[test]
fn allowlist_rejects_wallets_not_on_the_list() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: Some(vec!["allowed1".to_string()]),
        min_players: 2,
        max_players: 2,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    let err = buy_ticket(&mut deps, &env, "not-allowed", 0).unwrap_err();
    assert!(matches!(err, ContractError::NotAllowed {}));
    buy_ticket(&mut deps, &env, "allowed1", 0).unwrap();
}

#[test]
fn single_winner_pays_the_full_prize_and_ticket_revenue_and_fee_split() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    let res = buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();

    // 1 prize payout + 1 ticket-revenue-to-creator + 2 fee-split payouts (founder/treasury) = 4
    assert_eq!(res.messages.len(), 4);

    let config_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(config_bin).unwrap();
    // Fee is 1% of max potential revenue (max_entrants=2 * ticket_price=$1 =
    // 2,000,000 micro-USDC), floored at the $1 minimum - this tiny test ticket
    // price always lands on the floor, split 50/50 = 500,000 each.
    for (recipient, expected) in [
        (&config.founder_fee_address, 500_000u128),
        (&config.treasury_address, 500_000u128),
    ] {
        let sent = res.messages.iter().find_map(|m| match &m.msg {
            CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) if to_address == recipient.as_str() => {
                Some(amount.clone())
            }
            _ => None,
        });
        assert_eq!(sent, Some(coins(expected, USDC_DENOM)), "expected {expected} to {recipient}");
    }

    let winners_bin = query(deps.as_ref(), env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 1);
    assert_eq!(winners.prize_shares, vec![Uint128::new(1000)]);
}

#[test]
fn only_creator_can_draw_winner() {
    // max_players=10 (not 2) so buying 2 tickets doesn't sell out and
    // auto-draw (2026-07-22) - CloseRound early instead, to still exercise a
    // separate, manual DrawWinner call.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    execute(deps.as_mut(), later_env, mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
}

#[test]
fn non_creator_can_draw_winner_after_the_long_fallback_deadline() {
    // default unclaimed_deadline_days from `setup` is 90. Time is advanced
    // between opening (deposit_prize) and closing (early creator close,
    // max_players=10 so it doesn't sell out and auto-draw, 2026-07-22) so
    // opened_at != closed_at - otherwise this test couldn't tell a correct
    // closed_at-anchored deadline apart from a regression that accidentally
    // anchored it to opened_at instead.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();

    let mut close_env = env.clone();
    close_env.block.time = close_env.block.time.plus_seconds(20 * 86400);
    buy_ticket(&mut deps, &close_env, "player2", 1_000_000).unwrap(); // reaches min_players=2, still below max_players=10
    execute(deps.as_mut(), close_env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap(); // closed_at = opened_at + 20 days

    // opened_at + 90 days == closed_at + 70 days - a deadline wrongly
    // anchored to opened_at would already have passed here. Assert it's
    // still rejected, proving the deadline actually tracks closed_at.
    let mut wrong_anchor_env = env.clone();
    wrong_anchor_env.block.height = env.block.height + 5;
    wrong_anchor_env.block.time = env.block.time.plus_seconds(90 * 86400);
    let err = execute(deps.as_mut(), wrong_anchor_env, mock_info("player1", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    // 1 second before the real (closed_at-based) deadline: still rejected.
    let mut just_before_env = close_env.clone();
    just_before_env.block.height = env.block.height + 5;
    just_before_env.block.time = close_env.block.time.plus_seconds(90 * 86400 - 1);
    let err = execute(deps.as_mut(), just_before_env, mock_info("player1", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    // Exactly at the real deadline: succeeds.
    let mut after_env = close_env.clone();
    after_env.block.height = env.block.height + 5;
    after_env.block.time = close_env.block.time.plus_seconds(90 * 86400);
    execute(deps.as_mut(), after_env, mock_info("player1", &[]), ExecuteMsg::DrawWinner {}).unwrap();
}

#[test]
fn creator_can_close_round_early_without_reaching_max_or_timeout() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();

    // Well below max_players (10) and no time has elapsed - only the
    // creator's early-close path can succeed here.
    execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Closed);
}

#[test]
fn non_creator_cannot_close_round_early() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));
}

#[test]
fn creator_cannot_close_round_below_min_players() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));
}

#[test]
fn draw_winner_past_the_window_rearms_instead_of_drawing() {
    // max_players=10 (not 2) so buying 2 tickets doesn't sell out and
    // auto-draw (2026-07-22) - CloseRound early instead, to still exercise a
    // separate, manual DrawWinner call with a window to grind against.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap(); // draw_after_height = height + 5, window width 10

    let mut too_late_env = env.clone();
    too_late_env.block.height += 15; // first height past the ceiling
    let res = execute(deps.as_mut(), too_late_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "rearm_draw_window");
    assert_eq!(res.attributes.iter().find(|a| a.key == "rearm_count").unwrap().value, "1");
    assert!(res.messages.is_empty());

    let status = raffle_status(&deps, &too_late_env);
    assert_eq!(status.status, RaffleStatus::Closed);
    assert_eq!(status.draw_after_height, Some(too_late_env.block.height + 5));

    let err = execute(deps.as_mut(), too_late_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::DrawTooEarly { .. }));

    let mut drawable_env = too_late_env.clone();
    drawable_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), drawable_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    assert_eq!(draw_res.attributes.iter().find(|a| a.key == "action").unwrap().value, "draw_winner");
    let winners_bin = query(deps.as_ref(), drawable_env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 1);
}

#[test]
fn draw_winner_becomes_permissionless_after_2_rearms_without_waiting_the_full_deadline() {
    // Mirrors MAX_REARMS_BEFORE_PERMISSIONLESS in execute.rs (2, 2026-07-22) -
    // closes the free-rearm grinding hole: a non-creator is rejected before
    // the cap is reached (same reasons as only_creator_can_draw_winner), but
    // let in immediately once reached, without waiting the full
    // unclaimed_deadline_days (90 days by default).
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let mut past_window_env = env.clone();
    past_window_env.block.height += 15; // env.height + draw_delay_blocks(5) + draw_window_blocks(10)

    // 0 rearms so far - a random wallet still can't draw.
    let err = execute(deps.as_mut(), past_window_env.clone(), mock_info("rando", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    // Creator rearms twice - still the only one allowed to call, cap not
    // reached yet.
    let res = execute(deps.as_mut(), past_window_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    assert_eq!(res.attributes.iter().find(|a| a.key == "rearm_count").unwrap().value, "1");

    past_window_env.block.height += 15; // past the new window again
    let res = execute(deps.as_mut(), past_window_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    assert_eq!(res.attributes.iter().find(|a| a.key == "rearm_count").unwrap().value, "2");

    // Cap reached - a random wallet can now draw immediately, landing inside
    // the fresh window, without waiting the full unclaimed_deadline_days.
    let mut drawable_env = past_window_env;
    drawable_env.block.height += 5;
    let res = execute(deps.as_mut(), drawable_env, mock_info("rando", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "draw_winner");
}

#[test]
fn draw_winner_forces_the_draw_instead_of_rearming_a_third_time_once_the_cap_is_spent() {
    // Regression test for a real gap found by an Opus+Fable review
    // (2026-07-22) of the first version of this fix: capping rearm_count
    // only *authorized* a non-creator to draw once the cap was reached - it
    // never actually stopped the creator from rearming a 3rd, 4th, ... time
    // for free if nobody else happened to call DrawWinner in the meantime.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let mut past_window_env = env.clone();
    past_window_env.block.height += 15;
    execute(deps.as_mut(), past_window_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap(); // rearm 1
    past_window_env.block.height += 15;
    execute(deps.as_mut(), past_window_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap(); // rearm 2, cap now spent

    past_window_env.block.height += 15; // past the (would-be) window a 3rd time
    let res = execute(deps.as_mut(), past_window_env, mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    // Must draw for real here, not rearm again - the creator gets no more
    // free re-rolls once the cap is spent, regardless of who calls.
    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "draw_winner");
    assert!(!res.messages.is_empty());
}

#[test]
fn podium_picks_three_distinct_winners_with_creator_chosen_50_30_20_split() {
    let (mut deps, env) = setup(RaffleType::Podium, 3, 3, 0, vec![5000, 3000, 2000]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    let winners_bin = query(deps.as_ref(), env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 3);
    let unique: std::collections::BTreeSet<_> = winners.winners.iter().collect();
    assert_eq!(unique.len(), 3, "all three podium places must be distinct wallets");
    assert_eq!(winners.prize_shares, vec![Uint128::new(500), Uint128::new(300), Uint128::new(200)]);
}

#[test]
fn podium_supports_two_places_with_a_custom_split() {
    let (mut deps, env) = setup(RaffleType::Podium, 2, 2, 0, vec![6000, 4000]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let winners_bin = query(deps.as_ref(), env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 2);
    assert_eq!(winners.prize_shares, vec![Uint128::new(600), Uint128::new(400)]);
}

#[test]
fn podium_supports_more_than_three_places_and_rounds_dust_to_first_place() {
    let (mut deps, env) = setup(RaffleType::Podium, 4, 4, 0, vec![3334, 2222, 2222, 2222]);
    deposit_prize(&mut deps, &env, 100, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    buy_ticket(&mut deps, &env, "player4", 0).unwrap();

    let winners_bin = query(deps.as_ref(), env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 4);
    // 100 * 3334/10000 = 33 (floor), 100 * 2222/10000 = 22 (floor) x3 -> 99
    // allocated, the 1 leftover unit of dust goes to first place.
    assert_eq!(
        winners.prize_shares,
        vec![Uint128::new(34), Uint128::new(22), Uint128::new(22), Uint128::new(22)]
    );
}

#[test]
fn airdrop_splits_equally_and_supports_claim_and_reclaim() {
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    let res = buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    // no per-winner prize payout for Airdrop itself (that's pulled later via
    // ClaimAirdropShare); the 2 messages here are the founder/treasury fee split.
    assert_eq!(res.messages.len(), 2);

    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert_eq!(share.share, Uint128::new(500));
    assert!(!share.claimed);

    let claim_res = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    assert_eq!(claim_res.messages.len(), 1);
    // NOT marked claimed yet - only the reply confirming the transfer
    // succeeded finalizes it (2026-08-20 audit fix: the old code marked it
    // claimed before dispatch, so an honest transfer failure permanently
    // stranded the share with no retry and no reclaim).
    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert!(!share.claimed);

    simulate_reply(&mut deps, &env, claim_res.messages[0].id, true);
    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert!(share.claimed);

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap_err();
    assert!(matches!(err, ContractError::AlreadyClaimed {}));

    // player2 never claims; creator reclaims after the deadline.
    let mut after_deadline_env = env.clone();
    after_deadline_env.block.time = after_deadline_env.block.time.plus_seconds(91 * 86400);
    let reclaim_res = execute(
        deps.as_mut(),
        after_deadline_env,
        mock_info("creator", &[]),
        ExecuteMsg::ReclaimUnclaimed {},
    )
    .unwrap();
    assert_eq!(reclaim_res.attributes.iter().find(|a| a.key == "amount").unwrap().value, "500");
}

#[test]
fn airdrop_claim_failure_does_not_strand_the_share_and_allows_retry() {
    // 2026-08-20 audit fix regression test: an honest (non-malicious)
    // transfer failure used to permanently mark the claimant as "already
    // claimed" without ever paying them - no retry, and ReclaimUnclaimed
    // wouldn't sweep it either since it thought the share was handled.
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let claim_res = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    simulate_reply(&mut deps, &env, claim_res.messages[0].id, false);

    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert!(!share.claimed, "a failed transfer must not mark the share claimed");

    // Retry works - AlreadyClaimed does NOT fire, since the first attempt
    // never actually finalized.
    let retry_res = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    assert_eq!(retry_res.messages.len(), 1);
    simulate_reply(&mut deps, &env, retry_res.messages[0].id, true);

    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert!(share.claimed);
}

#[test]
fn airdrop_zero_share_is_marked_claimed_without_dispatching_a_transfer() {
    // 2026-08-20 audit fix regression test: a tiny prize split among many
    // players used to dispatch a doomed zero-amount transfer, whose
    // rejection (the CW20 standard itself rejects zero-amount transfers)
    // would count as a real failure toward the 3-strikes auto-blacklist -
    // letting anyone permanently blacklist any CW20 platform-wide for the
    // cost of one free raffle with a tiny prize and 3+ throwaway wallets.
    let (mut deps, env) = setup(RaffleType::Airdrop, 3, 3, 0, vec![]);
    deposit_prize(&mut deps, &env, 1, FEE_AMOUNT_USDC).unwrap(); // 1 unit / 3 players floors to 0
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert_eq!(share.share, Uint128::zero());

    let claim_res = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    assert!(claim_res.messages.is_empty());

    let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert!(share.claimed);
}

#[test]
fn retry_prize_payout_resends_an_unpaid_single_winner_share_after_a_failed_transfer() {
    // 2026-08-20 audit fix regression test: a failed SingleWinner/Podium
    // payout used to have no recovery path at all - the prize just sat
    // stuck in the contract forever.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    // Sellout draws immediately, in the same transaction as this ticket.
    let draw_res = buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let winners: WinnersResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::GetWinners {}).unwrap()).unwrap();
    assert_eq!(winners.prize_paid, vec![false]);

    let payout_id = draw_res
        .messages
        .iter()
        .find(|m| matches!(&m.msg, CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) if amount[0].denom == PRIZE_DENOM))
        .expect("draw should dispatch a prize payout")
        .id;
    simulate_reply(&mut deps, &env, payout_id, false);

    let winners: WinnersResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::GetWinners {}).unwrap()).unwrap();
    assert_eq!(winners.prize_paid, vec![false], "a failed transfer must not be marked paid");

    // Nothing else can retry this but RetryPrizePayout - permissionless.
    let retry_res = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::RetryPrizePayout {}).unwrap();
    assert_eq!(retry_res.messages.len(), 1);
    simulate_reply(&mut deps, &env, retry_res.messages[0].id, true);

    let winners: WinnersResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::GetWinners {}).unwrap()).unwrap();
    assert_eq!(winners.prize_paid, vec![true]);

    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::RetryPrizePayout {}).unwrap_err();
    assert!(matches!(err, ContractError::NothingToRetry {}));
}

#[test]
fn retry_prize_payout_failures_do_not_count_toward_the_auto_blacklist_threshold() {
    // 2026-08-20 audit fix (2nd round): `RetryPrizePayout` is permissionless
    // and unrate-limited - if its failures counted toward the 3-strikes
    // auto-blacklist the same way an original draw failure does, anyone
    // could cheaply force any CW20 prize token to get permanently
    // blacklisted platform-wide just by calling `RetryPrizePayout` and
    // failing it 3 times. Confirmed exploitable end-to-end by an
    // independent reviewer before this fix (before `RetryPrizePayout`
    // existed at all, SingleWinner only ever attempted its one payout once
    // per raffle, so 3 failures was structurally unreachable).
    let (mut deps, env) = instantiate_with_prize(None, Some("cw20token"));
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(FEE_AMOUNT_USDC, USDC_DENOM)),
        ExecuteMsg::PayServiceFee {},
    )
    .unwrap();
    let hook = to_json_binary(&Cw20HookMsg::DepositPrize {}).unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("cw20token", &[]),
        ExecuteMsg::Receive(Cw20ReceiveMsg {
            sender: "creator".to_string(),
            amount: Uint128::new(1000),
            msg: hook,
        }),
    )
    .unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let draw_res = buy_ticket(&mut deps, &env, "player2", 0).unwrap(); // sellout draws immediately

    let payout_id = draw_res
        .messages
        .iter()
        .find(|m| matches!(&m.msg, CosmosMsg::Wasm(WasmMsg::Execute { .. })))
        .expect("draw should dispatch the CW20 prize transfer")
        .id;
    // Original draw attempt fails once - this one DOES count.
    simulate_reply(&mut deps, &env, payout_id, false);

    // Fail via RetryPrizePayout 5 more times - none of these should ever
    // push the raffle to prize_blocked, since retries don't count. If they
    // did, one of these calls would eventually error with PrizeBlocked
    // instead of dispatching a fresh SubMsg, or a second (ReportCw20Failure)
    // submessage would show up alongside the retry.
    for _ in 0..5 {
        let retry_res = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::RetryPrizePayout {}).unwrap();
        assert_eq!(retry_res.messages.len(), 1, "a blocked raffle would reject this or add a report submessage");
        simulate_reply(&mut deps, &env, retry_res.messages[0].id, false);
    }
}

#[test]
fn airdrop_claim_reply_ids_are_unique_per_dispatch_so_concurrent_pending_claims_cannot_clobber_each_other() {
    // 2026-08-20 audit fix (2nd round, found independently by two
    // reviewers): the original design used a single shared storage slot for
    // "the claimer currently in flight" - safe for ordinary sequential
    // calls, but not if a malicious CW20 prize reenters ClaimAirdropShare
    // from inside its own Transfer handler before the outer call's reply
    // resolves (free/Airdrop CW20 prizes are unrestricted, and the token
    // could arrange to be a participant itself). This mock harness can't
    // simulate true nested reentrancy (no multi-contract dispatch), but this
    // test proves the underlying fix: two claims can have their SubMsg
    // dispatched without either resolving first (the same "two pending
    // claims coexist" state reentrancy would produce), and resolving them in
    // EITHER order still finalizes the right wallet - proof the per-id map
    // can't be clobbered the way the old single `Item` slot could (the old
    // design would have used the exact same id for both, and the second
    // reply to resolve would find the slot already cleared by the first).
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let claim1 = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    let claim2 = execute(deps.as_mut(), env.clone(), mock_info("player2", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    assert_ne!(claim1.messages[0].id, claim2.messages[0].id, "each dispatch must get its own reply id");

    // Resolve OUT OF ORDER - player2's reply first, exactly the ordering a
    // reentrant nested call would produce.
    simulate_reply(&mut deps, &env, claim2.messages[0].id, true);
    simulate_reply(&mut deps, &env, claim1.messages[0].id, true);

    for player in ["player1", "player2"] {
        let share_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyAirdropShare { wallet: player.to_string() }).unwrap();
        let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
        assert!(share.claimed, "{player} should be marked claimed regardless of reply resolution order");
    }
}

#[test]
fn airdrop_claim_rejects_a_second_dispatch_for_the_same_wallet_while_the_first_is_still_in_flight() {
    // 2026-08-20 audit fix (round 4, found independently by two reviewers):
    // the reply-id-map fix above stops a reentrant nested claim from
    // clobbering ANOTHER wallet's pending entry, but on its own did nothing
    // to stop the SAME wallet from dispatching a SECOND payout before the
    // first one's reply resolves - AIRDROP_CLAIMS only gets set `true` in
    // the reply (see the honest-retry test above for why), so AlreadyClaimed
    // alone read `false` for both. A malicious CW20 prize that is also a
    // unique_player could reenter ClaimAirdropShare as itself from inside
    // its own Transfer handler and get paid twice (or more) out of the
    // raffle's real prize balance, at other honest claimants' expense. This
    // mock harness can't simulate true nested reentrancy, but it proves the
    // guard itself: calling ClaimAirdropShare again for a wallet with an
    // unresolved dispatch must be rejected, not silently dispatch another
    // transfer.
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let claim1 = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    assert_eq!(claim1.messages.len(), 1);

    // Same wallet, same raffle, before the first dispatch's reply resolves -
    // must be rejected, not dispatch a second payout.
    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap_err();
    assert!(matches!(err, ContractError::ClaimAlreadyInFlight {}));

    // Resolving the original dispatch clears the in-flight marker; a THIRD
    // call afterward correctly falls through to AlreadyClaimed instead
    // (the share is genuinely paid now, not just in flight).
    simulate_reply(&mut deps, &env, claim1.messages[0].id, true);
    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap_err();
    assert!(matches!(err, ContractError::AlreadyClaimed {}));
}

#[test]
fn native_prize_transfer_failures_never_count_toward_the_auto_blacklist_threshold() {
    // 2026-08-20 audit fix (round 4): RaffleState::prize_transfer_failures's
    // own doc comment already claimed a native BankMsg::Send "can never
    // count as a failure" - true in practice (a valid-address native send
    // doesn't fail), but nothing in handle_prize_transfer_failure actually
    // enforced it before this fix; it counted unconditionally regardless of
    // asset type. If a native prize transfer ever DID fail 3 times (e.g. a
    // Podium with all 3 places failing on the original draw dispatch, the
    // same single-transaction path an independent reviewer flagged for the
    // CW20 case), prize_blocked would have latched permanently: unlike a
    // CW20, maybe_clear_prize_blocked has no blacklist to re-check for
    // Native, and none of Cancel/Expire/Reclaim accept a Drawn raffle - the
    // prize would be stuck forever, for an asset type that was never
    // supposed to be able to reach the threshold at all.
    let (mut deps, env) = setup(RaffleType::Podium, 3, 3, 0, vec![5000, 3000, 2000]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    // Selling out draws immediately, dispatching all 3 native payouts at
    // once - the same-transaction path this test is about.
    let draw_res = buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    let payout_ids: Vec<u64> = draw_res
        .messages
        .iter()
        .filter(|m| matches!(&m.msg, CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) if amount[0].denom == PRIZE_DENOM))
        .map(|m| m.id)
        .collect();
    assert_eq!(payout_ids.len(), 3, "all 3 podium places should dispatch a native payout");

    // Fail all 3 - if native counted like CW20 does, this alone would hit
    // PRIZE_TRANSFER_FAILURE_THRESHOLD (3) in a single transaction.
    for id in &payout_ids {
        simulate_reply(&mut deps, &env, *id, false);
    }

    let winners: WinnersResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::GetWinners {}).unwrap()).unwrap();
    assert_eq!(winners.prize_paid, vec![false, false, false]);

    // Not blocked - RetryPrizePayout still dispatches fresh SubMsgs for all
    // 3 instead of erroring with PrizeBlocked.
    let retry_res = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::RetryPrizePayout {}).unwrap();
    assert_eq!(retry_res.messages.len(), 3);
    for m in &retry_res.messages {
        simulate_reply(&mut deps, &env, m.id, true);
    }

    let winners: WinnersResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::GetWinners {}).unwrap()).unwrap();
    assert_eq!(winners.prize_paid, vec![true, true, true]);
}

#[test]
fn reclaim_unclaimed_rejects_while_a_claim_is_still_in_flight() {
    // 2026-08-21 audit fix (round 5): ReclaimUnclaimed's sweep only excludes
    // wallets already in AIRDROP_CLAIMS (confirmed paid) - a claim that's
    // been dispatched but hasn't had its reply resolve yet isn't in that map
    // yet, so without this guard the sweep would wrongly count that share as
    // unclaimed and take it too, stranding the in-flight claimant once their
    // reply finally resolves against an already-drained balance.
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let claim1 = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    assert_eq!(claim1.messages.len(), 1);

    let mut after_deadline_env = env.clone();
    after_deadline_env.block.time = after_deadline_env.block.time.plus_seconds(91 * 86400);
    let err = execute(
        deps.as_mut(),
        after_deadline_env.clone(),
        mock_info("creator", &[]),
        ExecuteMsg::ReclaimUnclaimed {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::ClaimsStillInFlight {}));

    // Resolving the pending claim clears the in-flight marker - reclaim
    // works normally afterward, and correctly excludes player1's now-paid
    // share from the sweep.
    simulate_reply(&mut deps, &env, claim1.messages[0].id, true);
    let reclaim_res = execute(
        deps.as_mut(),
        after_deadline_env,
        mock_info("creator", &[]),
        ExecuteMsg::ReclaimUnclaimed {},
    )
    .unwrap();
    assert_eq!(reclaim_res.attributes.iter().find(|a| a.key == "amount").unwrap().value, "500");
}

#[test]
fn reclaim_unclaimed_sweeps_the_full_prize_when_every_share_floors_to_zero() {
    // 2026-08-20 audit fix (2nd round): the old formula (airdrop_share *
    // unclaimed_count) swept 0 in this degenerate case - every wallet is
    // marked "claimed" immediately with nothing owed (see the zero-share
    // guard), so unclaimed_count lands on 0 even though the whole deposited
    // prize never moved anywhere. Confirmed end-to-end by an independent
    // reviewer. The fix sweeps the true remainder (prize_amount minus what
    // was actually paid out), recovering the full amount regardless.
    let (mut deps, env) = setup(RaffleType::Airdrop, 3, 3, 0, vec![]);
    deposit_prize(&mut deps, &env, 1, FEE_AMOUNT_USDC).unwrap(); // 1 unit / 3 players floors to 0
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    // player1 actually calls ClaimAirdropShare (auto-marked claimed, zero
    // owed); player2/player3 never bother - both paths must still recover
    // the full 1 unit.
    execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();

    let mut after_deadline_env = env.clone();
    after_deadline_env.block.time = after_deadline_env.block.time.plus_seconds(91 * 86400);
    let reclaim_res = execute(
        deps.as_mut(),
        after_deadline_env,
        mock_info("creator", &[]),
        ExecuteMsg::ReclaimUnclaimed {},
    )
    .unwrap();
    assert_eq!(reclaim_res.attributes.iter().find(|a| a.key == "amount").unwrap().value, "1");
}

#[test]
fn reclaim_unclaimed_also_recovers_the_floor_division_remainder() {
    // General correctness check for the same 2026-08-20 fix: prize=1000
    // split 3 ways floors to 333 each (1 unit of dust the old formula never
    // recovered). 2 wallets claim (666 total), 1 doesn't - reclaim should
    // recover 334 (the dust unit PLUS the unclaimed share), not just the
    // unclaimed share (333) the old formula would have given.
    let (mut deps, env) = setup(RaffleType::Airdrop, 3, 3, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    for player in ["player1", "player2"] {
        let claim_res = execute(deps.as_mut(), env.clone(), mock_info(player, &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
        simulate_reply(&mut deps, &env, claim_res.messages[0].id, true);
    }
    // player3 never claims.

    let mut after_deadline_env = env.clone();
    after_deadline_env.block.time = after_deadline_env.block.time.plus_seconds(91 * 86400);
    let reclaim_res = execute(
        deps.as_mut(),
        after_deadline_env,
        mock_info("creator", &[]),
        ExecuteMsg::ReclaimUnclaimed {},
    )
    .unwrap();
    assert_eq!(reclaim_res.attributes.iter().find(|a| a.key == "amount").unwrap().value, "334");
}

#[test]
fn soft_close_deadline_is_clamped_to_the_60_day_hard_cap_even_when_min_players_is_reached_late() {
    // 2026-08-20 audit fix regression test: the initial deadline used to
    // have no clamp at all against the 60-day hard cap - only the extension
    // branch consulted it. A creator-chosen 31-day window reached late (55
    // days in) would land the deadline on day 86, past the cap it's
    // supposed to be bounded by.
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 4,
        round_timeout_seconds: 2_678_400, // 31 days, the creator-chosen maximum
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap(); // opened_at = T0

    let mut late_env = env.clone();
    late_env.block.time = late_env.block.time.plus_seconds(55 * 86_400); // T0 + 55 days
    buy_ticket(&mut deps, &late_env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &late_env, "player2", 0).unwrap(); // reaches min_players here

    let mut query_env = env.clone();
    query_env.block.time = late_env.block.time;
    let status = raffle_status(&deps, &query_env);
    // Hard cap is T0 + 60 days; querying at T0 + 55 days should leave
    // exactly 5 days, not the unclamped ~31 days round_timeout_seconds
    // alone would imply.
    assert_eq!(status.seconds_remaining, Some(5 * 86_400));
}

#[test]
fn soft_close_extension_never_pushes_the_deadline_past_the_hard_cap_or_backwards() {
    // 2026-08-20 audit fix regression test: the old extension math
    // (`min(extended, hard_cap)` with no floor against the current
    // deadline) could move the deadline BACKWARDS once it was already past
    // the hard cap (reachable via the bug above), letting anyone close the
    // raffle immediately - the opposite of what the anti-snipe extension
    // exists to prevent.
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 4,
        round_timeout_seconds: 2_678_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap(); // opened_at = T0

    let mut late_env = env.clone();
    late_env.block.time = late_env.block.time.plus_seconds(55 * 86_400);
    buy_ticket(&mut deps, &late_env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &late_env, "player2", 0).unwrap(); // deadline pinned at T0 + 60 days

    // 30 minutes before that deadline - inside the final hour, triggers the
    // anti-snipe extension.
    let mut snipe_env = env.clone();
    snipe_env.block.time = env.block.time.plus_seconds(60 * 86_400 - 1_800);
    buy_ticket(&mut deps, &snipe_env, "player3", 0).unwrap();

    let mut query_env = env.clone();
    query_env.block.time = snipe_env.block.time;
    let status = raffle_status(&deps, &query_env);
    // Still pinned at the hard cap - 30 minutes remain, neither pushed past
    // it nor yanked backward toward 0.
    assert_eq!(status.seconds_remaining, Some(1_800));
}

#[test]
fn buying_a_ticket_after_the_deadline_already_passed_does_not_extend_it() {
    // Found by a third, independent free-tier audit pass (2026-08-20,
    // pre-existing since the original soft-close design, not introduced by
    // any of this session's fixes): the anti-snipe extension check
    // (`seconds_remaining &lt;= ANTI_SNIPE_EXTENSION_SECONDS`) used
    // `saturating_sub`, which floors at 0 once the deadline has already
    // elapsed - indistinguishable from genuinely being inside the final
    // hour. Since BuyTicket never checks the deadline itself (only
    // CloseRound does - the raffle stays legally Open and purchasable until
    // someone closes it), ANY ticket bought after the deadline had already
    // passed would extend it another hour, letting anyone keep a raffle
    // open indefinitely (up to the 60-day hard cap) just by buying tickets
    // periodically - exactly the "well-timed late purchases stretch the
    // raffle out" failure mode soft-close was built to prevent in the first
    // place, reopened through the extension branch instead of a full reset.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 4, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap(); // opened_at = T0
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap(); // min_players reached, deadline = T0 + 86400

    // 2 hours past that deadline - well past both the deadline itself and
    // any legitimate "final hour" window.
    let mut late_env = env.clone();
    late_env.block.time = late_env.block.time.plus_seconds(86_400 + 7200);
    buy_ticket(&mut deps, &late_env, "player3", 0).unwrap();

    let mut query_env = env.clone();
    query_env.block.time = late_env.block.time;
    let status = raffle_status(&deps, &query_env);
    // Deadline must still be the original T0+86400, not extended - so
    // seconds_remaining floors at 0 (already elapsed), not a fresh hour.
    assert_eq!(status.seconds_remaining, Some(0));
}

#[test]
fn round_timeout_seconds_at_the_new_minimum_does_not_degenerate_into_a_rolling_deadline() {
    // Round-10 audit fix regression test (found by Opus, proven with a live
    // probe before this fix landed): the old MIN_ROUND_TIMEOUT_SECONDS (1h)
    // equaled ANTI_SNIPE_EXTENSION_SECONDS exactly, so a raffle instantiated
    // at that floor started life already inside the anti-snipe window -
    // EVERY purchase, at any point, extended the deadline, turning the
    // "final hour" into the raffle's entire lifetime. This is exactly the
    // rolling-deadline behavior soft-close was designed to prevent (see
    // `Config::round_timeout_seconds`'s doc comment), and it's what the real
    // frontend always instantiated with. Confirms the new floor (24h) keeps
    // a real, non-extending period for casual purchases well before the
    // final hour.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 50, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap(); // opened_at = T0
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap(); // min_players reached, deadline = T0 + 86400

    // 10 hours in - well outside the final-hour anti-snipe zone.
    let mut mid_env = env.clone();
    mid_env.block.time = mid_env.block.time.plus_seconds(10 * 3_600);
    buy_ticket(&mut deps, &mid_env, "player3", 0).unwrap();

    let mut query_env = env.clone();
    query_env.block.time = mid_env.block.time;
    let status = raffle_status(&deps, &query_env);
    // Ticking down normally toward the original T0+86400 deadline, not
    // pinned at a rolling +3600 from the purchase - proves the deadline
    // wasn't extended by a purchase nowhere near the final hour.
    assert_eq!(status.seconds_remaining, Some(86_400 - 10 * 3_600));

    // A permissionless CloseRound must still be refused this early - the
    // window genuinely hasn't elapsed (distinct from the old bug, where it
    // never would have been refused for the right reason for the entire
    // 86400s, since every purchase kept resetting it moot).
    let close_err = execute(
        deps.as_mut(),
        query_env,
        mock_info("anyone", &[]),
        ExecuteMsg::CloseRound {},
    )
    .unwrap_err();
    assert!(matches!(close_err, ContractError::CannotCloseRound {}));
}

#[test]
fn cancel_raffle_prize_refund_failure_does_not_block_the_ticket_and_fee_refunds() {
    // 2026-08-20 audit fix regression test: the prize-to-creator refund used
    // to be a plain message bundled with the ticket/fee refunds - if the
    // prize token reverted for EVERYONE (e.g. paused by its own admin, not
    // an attack), the entire CancelRaffle/ExpireRaffle transaction aborted,
    // stranding real players' ticket refunds too.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 3, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();

    let res = execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CancelRaffle {}).unwrap();
    let prize_submsg = res
        .messages
        .iter()
        .find(|m| m.reply_on != ReplyOn::Never)
        .expect("the prize refund should be the one reply-tracked submessage");
    assert!(
        matches!(&prize_submsg.msg, CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) if amount[0].amount == Uint128::new(1000))
    );

    // Simulating the prize refund itself failing must not propagate as an
    // error - the ticket/fee refunds bundled in the same response are
    // already dispatched separately and don't depend on this outcome.
    simulate_reply(&mut deps, &env, prize_submsg.id, false);

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Cancelled);
}

#[test]
fn cancel_raffle_refunds_prize_fee_and_tickets() {
    // min_players=2, only 1 ticket bought - cancelling BEFORE min_players is
    // reached, so only the base 20% cancellation penalty applies (not the
    // additional 80% "late" layer) - see the 2026-08-20 cancellation-penalty
    // redesign. This raffle's real required fee floors at the $1 minimum
    // (max_players=3 -> max_entrants=3 -> 1% of $3 potential = $0.03,
    // floored to $1 = 1_000_000 micros - the extra 2_000_000 sent at
    // deposit_prize was already refunded then as overpayment, unrelated to
    // this cancellation): 20% penalty = 200_000, fee_refund = 800_000,
    // split 50/50 founder/treasury = 100_000 each.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 3, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();

    let res = execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CancelRaffle {}).unwrap();
    // prize refund + partial fee refund + player1's ticket refund + founder
    // cut + treasury cut of the forfeited penalty = 5
    assert_eq!(res.messages.len(), 5);

    let bank_sends: Vec<(String, Vec<cosmwasm_std::Coin>)> = res
        .messages
        .iter()
        .map(|m| match &m.msg {
            CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) => {
                (to_address.clone(), amount.clone())
            }
            other => panic!("expected only BankMsg::Send, got {other:?}"),
        })
        .collect();
    let sent_amount = |addr: &str, denom: &str| -> Option<Uint128> {
        bank_sends
            .iter()
            .filter(|(a, coins)| a == addr && coins.iter().any(|c| c.denom == denom))
            .flat_map(|(_, coins)| coins.iter().filter(|c| c.denom == denom).map(|c| c.amount))
            .next()
    };
    assert_eq!(sent_amount("creator", PRIZE_DENOM), Some(Uint128::new(1000)));
    assert_eq!(sent_amount("creator", USDC_DENOM), Some(Uint128::new(800_000)));
    assert_eq!(sent_amount("player1", USDC_DENOM), Some(Uint128::new(1_000_000)));

    let config: ConfigResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::GetConfig {}).unwrap()).unwrap();
    assert_eq!(sent_amount(config.founder_fee_address.as_str(), USDC_DENOM), Some(Uint128::new(100_000)));
    assert_eq!(sent_amount(config.treasury_address.as_str(), USDC_DENOM), Some(Uint128::new(100_000)));

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Cancelled);
}

#[test]
fn get_entrants_lists_every_ticket_including_duplicates_for_repeat_buyers() {
    // Found missing live (2026-07-23): there was no way for a wallet to know
    // its own ticket count in a raffle, unlike wheel-manager's
    // GetRoundEntrants - a player buying tickets had no confirmation each
    // purchase actually registered. Mirrors that same query shape exactly.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 6, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();

    let bin = query(deps.as_ref(), env, QueryMsg::GetEntrants {}).unwrap();
    let entrants: EntrantsResponse = from_json(bin).unwrap();
    let addrs: Vec<&str> = entrants.entrants.iter().map(|a| a.as_str()).collect();
    assert_eq!(addrs, vec!["player1", "player1", "player2"]);
}

#[test]
fn get_config_returns_the_instantiate_settings() {
    let (deps, env) = setup(RaffleType::SingleWinner, 2, 6, 0, vec![]);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.max_players, 6);
    assert_eq!(config.min_players, 2);
    assert_eq!(config.raffle_type, RaffleType::SingleWinner);
    assert_eq!(config.fee_amount_usdc, Uint128::new(FEE_AMOUNT_USDC));
}

#[test]
fn explicit_creator_field_overrides_info_sender() {
    // Regression test for a real bug found live (2026-07-23): when
    // create-your-own-luck-factory instantiates a raffle via a submessage,
    // info.sender here is the factory's own address, not the human wallet
    // that actually asked for the raffle - without this field, every raffle
    // created through the factory would end up with an unreachable creator
    // (a contract address can never sign DepositPrize/DrawWinner/etc.).
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: Some("real_human_wallet".to_string()),
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 2,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    // Simulates the factory calling Instantiate as a submessage: info.sender
    // is the factory's own address, distinct from the creator field.
    instantiate(deps.as_mut(), env.clone(), mock_info("factory_contract_address", &[]), msg).unwrap();

    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.creator.as_str(), "real_human_wallet");
}

fn instantiate_with_prize(
    prize_native_denom: Option<&str>,
    prize_cw20_address: Option<&str>,
) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 2,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: prize_native_denom.map(|s| s.to_string()),
        prize_cw20_address: prize_cw20_address.map(|s| s.to_string()),
        podium_shares_bps: vec![],
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    (deps, env)
}

#[test]
fn cw20_prize_needs_pay_service_fee_then_the_cw20_send_hook() {
    let (mut deps, env) = instantiate_with_prize(None, Some("cw20token"));

    // Can't use native DepositPrize when the prize is CW20.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(1000, "somedenom")),
        ExecuteMsg::DepositPrize {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::PrizeIsCw20 {}));

    // Must pay the fee first.
    let hook = to_json_binary(&Cw20HookMsg::DepositPrize {}).unwrap();
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("cw20token", &[]),
        ExecuteMsg::Receive(Cw20ReceiveMsg {
            sender: "creator".to_string(),
            amount: Uint128::new(1000),
            msg: hook.clone(),
        }),
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::MustPayServiceFeeSeparately {}));

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(FEE_AMOUNT_USDC, USDC_DENOM)),
        ExecuteMsg::PayServiceFee {},
    )
    .unwrap();

    // Now the CW20 contract's Send-triggered Receive call actually deposits the prize.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("cw20token", &[]),
        ExecuteMsg::Receive(Cw20ReceiveMsg {
            sender: "creator".to_string(),
            amount: Uint128::new(1000),
            msg: hook,
        }),
    )
    .unwrap();

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Open);
    assert_eq!(status.prize_amount, Uint128::new(1000));

    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    let draw_res = buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let prize_msg = draw_res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, msg, .. }) if contract_addr == "cw20token" => {
            Some(from_json::<Cw20ExecuteMsg>(msg).unwrap())
        }
        _ => None,
    });
    match prize_msg {
        Some(Cw20ExecuteMsg::Transfer { amount, .. }) => assert_eq!(amount, Uint128::new(1000)),
        _ => panic!("expected a Cw20ExecuteMsg::Transfer to the cw20 prize token"),
    }
}

#[test]
fn native_prize_same_denom_as_usdc_fee_needs_pay_service_fee_first() {
    let (mut deps, env) = instantiate_with_prize(Some(USDC_DENOM), None);

    // Sending prize + fee combined in one DepositPrize call can't work here -
    // there'd be no way to tell how much of the single coin is which.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &[coin(1000, USDC_DENOM)]),
        ExecuteMsg::DepositPrize {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::MustPayServiceFeeSeparately {}));

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(FEE_AMOUNT_USDC, USDC_DENOM)),
        ExecuteMsg::PayServiceFee {},
    )
    .unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(1000, USDC_DENOM)),
        ExecuteMsg::DepositPrize {},
    )
    .unwrap();

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Open);
    assert_eq!(status.prize_amount, Uint128::new(1000));
    assert!(status.fee_paid);
}

#[test]
fn instantiate_rejects_degenerate_player_bounds() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let base_msg = |min_players: u32, max_players: u32| InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players,
        max_players,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}

#[test]
fn instantiate_rejects_unclaimed_deadline_days_out_of_range() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let base_msg = |unclaimed_deadline_days: u64| InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidUnclaimedDeadlineDays { .. }));

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(9000)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidUnclaimedDeadlineDays { .. }));

    // Boundaries are inclusive.
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(1)).unwrap();
    instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(365)).unwrap();
}

#[test]
fn instantiate_rejects_round_timeout_seconds_out_of_range() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let base_msg = |round_timeout_seconds: u64| InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidRoundTimeoutSeconds { .. }));

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(u64::MAX)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidRoundTimeoutSeconds { .. }));

    // Boundaries are inclusive - 24h to 31 days (2026-08-20 soft-close
    // redesign, narrowed from the old 60s-365day generic overflow-safety
    // range now that this is the creator's real marketing-window choice;
    // floor raised from 1h to 24h in the round-10 audit fix - see
    // `MIN_ROUND_TIMEOUT_SECONDS`'s own doc comment).
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(86_400)).unwrap();
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(2_678_400)).unwrap();

    // The old 1h floor (round-10 audit fix regression check): still a
    // syntactically valid u64, but now below MIN_ROUND_TIMEOUT_SECONDS, so
    // it must be rejected rather than silently accepted like it was before
    // this fix.
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(3_600)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidRoundTimeoutSeconds { .. }));
}

#[test]
fn instantiate_rejects_draw_delay_blocks_out_of_range() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let base_msg = |draw_delay_blocks: u64| InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidDrawDelayBlocks { .. }));

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(u64::MAX)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidDrawDelayBlocks { .. }));

    // Boundaries are inclusive.
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(1)).unwrap();
    instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(1_000_000)).unwrap();
}

#[test]
fn instantiate_rejects_draw_window_blocks_out_of_range() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let base_msg = |draw_window_blocks: u64| InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidDrawWindowBlocks { .. }));

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(u64::MAX)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidDrawWindowBlocks { .. }));

    // Boundaries are inclusive.
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(1)).unwrap();
    instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(1_000_000)).unwrap();
}

#[test]
fn ticket_cap_per_wallet_is_half_of_max_players_minimum_one() {
    // Half-of-max_players cap only applies to paid raffles (2026-07-21) -
    // free raffles cap at 1/wallet regardless, see the dedicated test below.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 4, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    // max_players=4 -> cap = max(1, 4/2) = 2.
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    let err = buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));
}

#[test]
fn free_raffle_caps_at_one_ticket_per_wallet_for_single_winner_and_podium_too() {
    // Same max_players=4 that would allow cap=2 if paid - free raffles cap
    // at 1 regardless, so a whale can't grab free entries for nothing.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 4, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let err = buy_ticket(&mut deps, &env, "player1", 0).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 1 }));
}

#[test]
fn airdrop_caps_at_one_ticket_per_wallet_regardless_of_max_players() {
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 1000, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, 18_000_000).unwrap();

    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let err = buy_ticket(&mut deps, &env, "player1", 0).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 1 }));
}

fn paid_raffle_prize_msg(prize_native_denom: Option<&str>, prize_cw20_address: Option<&str>) -> InstantiateMsg {
    InstantiateMsg {
        creator: None,
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::new(1_000_000),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 2,
        round_timeout_seconds: 86_400,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        factory_address: FACTORY_ADDRESS.to_string(),
        prize_native_denom: prize_native_denom.map(|s| s.to_string()),
        prize_cw20_address: prize_cw20_address.map(|s| s.to_string()),
        podium_shares_bps: vec![],
    }
}

#[test]
fn instantiate_rejects_cw20_prize_for_a_paid_raffle() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = paid_raffle_prize_msg(None, Some("cw20token"));
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PrizeAssetNotAllowlisted {}));
}

#[test]
fn instantiate_rejects_non_whitelisted_native_prize_for_a_paid_raffle() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = paid_raffle_prize_msg(Some("unft"), None);
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PrizeAssetNotAllowlisted {}));
}

#[test]
fn instantiate_allows_all_three_whitelisted_native_prizes_for_a_paid_raffle() {
    // "LUNC" and USDC_DENOM are both "uluna" on this testnet (2026-07-23,
    // see USDC_DENOM's comment in contract.rs) - this loop deliberately still
    // lists both symbolically rather than hardcoding literals, so it stays
    // correct if that ever changes back to a distinct value.
    for denom in ["uluna", USDC_DENOM, "uusd"] {
        let mut deps = mock_deps_with_factory();
        let env = mock_env();
        let msg = paid_raffle_prize_msg(Some(denom), None);
        instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap();
    }
}

#[test]
fn instantiate_allows_any_prize_asset_for_a_free_raffle() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let mut msg = paid_raffle_prize_msg(None, Some("some_random_cw20"));
    msg.ticket_price = Uint128::zero();
    instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap();
}

#[test]
fn buy_ticket_rejects_unexpected_funds_on_a_free_raffle() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &coins(500, "some_other_denom")),
        ExecuteMsg::BuyTicket {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn buy_ticket_rejects_a_second_unrelated_denom_alongside_the_correct_ticket_payment() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    let mut funds = coins(100, TICKET_DENOM);
    funds.push(coin(50, "some_other_denom"));
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &funds),
        ExecuteMsg::BuyTicket {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn close_round_rejects_unexpected_funds() {
    // max_players=3 so 2 tickets alone don't auto-close - CloseRound below
    // still needs to run its own course (creator's early-close path) to
    // exercise the funds check on that call.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 3, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info("creator", &coins(1, "some_other_denom")),
        ExecuteMsg::CloseRound {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn draw_winner_rejects_unexpected_funds() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let err = execute(
        deps.as_mut(),
        later_env,
        mock_info("creator", &coins(1, "some_other_denom")),
        ExecuteMsg::DrawWinner {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn claim_airdrop_share_rejects_unexpected_funds() {
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info("player1", &coins(1, "some_other_denom")),
        ExecuteMsg::ClaimAirdropShare {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn reclaim_unclaimed_rejects_unexpected_funds() {
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 2, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    // Selling out draws immediately, in the same transaction as this closing
    // ticket (2026-07-22) - no separate DrawWinner call needed or possible.
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let mut after_deadline_env = env;
    after_deadline_env.block.time = after_deadline_env.block.time.plus_seconds(91 * 86400);
    let err = execute(
        deps.as_mut(),
        after_deadline_env,
        mock_info("creator", &coins(1, "some_other_denom")),
        ExecuteMsg::ReclaimUnclaimed {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn cancel_raffle_rejects_unexpected_funds() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 3, 1_000_000, vec![]);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("creator", &coins(1, "some_other_denom")),
        ExecuteMsg::CancelRaffle {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn instantiate_rejects_non_usdc_ticket_denom_for_a_paid_raffle() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        ticket_denom: "unft".to_string(),
        ..paid_raffle_prize_msg(Some(PRIZE_DENOM), None)
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PaidTicketMustBeUsdc {}));
}

#[test]
fn instantiate_allows_any_ticket_denom_for_a_free_raffle() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let mut msg = paid_raffle_prize_msg(Some(PRIZE_DENOM), None);
    msg.ticket_price = Uint128::zero();
    msg.ticket_denom = "unft".to_string();
    instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap();
}

#[test]
fn instantiate_rejects_ticket_price_below_the_one_dollar_minimum() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        ticket_price: Uint128::new(999_999),
        ..paid_raffle_prize_msg(Some(PRIZE_DENOM), None)
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::TicketPriceBelowMinimum { min: 1_000_000 }));
}

#[test]
fn instantiate_rejects_ticket_price_with_sub_cent_dust() {
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    let msg = InstantiateMsg {
        creator: None,
        ticket_price: Uint128::new(1_000_001), // $1.0001 - not a whole cent
        ..paid_raffle_prize_msg(Some(PRIZE_DENOM), None)
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::TicketPriceNotWholeCents { cent: 10_000 }));
}

#[test]
fn instantiate_allows_ticket_price_at_the_minimum_and_in_whole_cent_increments() {
    for ticket_price in [1_000_000u128, 1_010_000, 1_100_000, 2_000_000] {
        let mut deps = mock_deps_with_factory();
        let env = mock_env();
        let msg = InstantiateMsg {
            creator: None,
            ticket_price: Uint128::new(ticket_price),
            ..paid_raffle_prize_msg(Some(PRIZE_DENOM), None)
        };
        instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap();
    }
}

#[test]
fn paid_raffle_fee_floors_at_one_dollar_for_small_potential_revenue() {
    // max_players=2, ticket_price=$1 (the paid-raffle minimum) -> cap=1,
    // max_entrants=2, potential=2,000,000 micro, 1% = 20,000 - floored to the
    // $1 minimum.
    let msg = InstantiateMsg {
        creator: None,
        ticket_price: Uint128::new(1_000_000),
        ..paid_raffle_prize_msg(Some(PRIZE_DENOM), None)
    };
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.fee_amount_usdc, Uint128::new(1_000_000));
}

#[test]
fn paid_raffle_fee_scales_as_one_percent_of_max_potential_revenue() {
    // max_players=100 (SingleWinner/Podium's ceiling), ticket_price=$10 ->
    // cap=max(1,100/2)=50, max_entrants=99*50+1=4951,
    // potential=4951*10_000_000=49,510,000,000 micro ("$49,510" - matches
    // the numbers used to design this formula), 1% = 495,100,000 ("$495.10"),
    // comfortably above the $1 floor so this exercises the real formula, not
    // just the floor.
    let msg = InstantiateMsg {
        creator: None,
        max_players: 100,
        min_players: 2,
        ticket_price: Uint128::new(10_000_000),
        ..paid_raffle_prize_msg(Some(PRIZE_DENOM), None)
    };
    let mut deps = mock_deps_with_factory();
    let env = mock_env();
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.fee_amount_usdc, Uint128::new(495_100_000));
}

#[test]
fn withdraw_ticket_refunds_before_min_players_is_reached() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 3, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap(); // 2 tickets, still below min_players=3

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket {},
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    match &res.messages[0].msg {
        CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, "player1");
            assert_eq!(amount, &coins(2_000_000, USDC_DENOM));
        }
        other => panic!("expected BankMsg::Send, got {other:?}"),
    }

    let status = raffle_status(&deps, &env);
    assert_eq!(status.unique_player_count, 0);
    assert_eq!(status.ticket_count, 0);

    // Nothing left to withdraw the second time.
    let err = execute(deps.as_mut(), env, mock_info("player1", &[]), ExecuteMsg::WithdrawTicket {}).unwrap_err();
    assert!(matches!(err, ContractError::NoTicketsToWithdraw {}));
}

#[test]
fn withdraw_ticket_rejects_once_min_players_is_reached() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap(); // reaches min_players=2

    let err = execute(deps.as_mut(), env, mock_info("player1", &[]), ExecuteMsg::WithdrawTicket {}).unwrap_err();
    assert!(matches!(err, ContractError::RaffleAlreadyLocked {}));
}

#[test]
fn withdraw_ticket_stays_open_for_airdrop_even_after_min_players_is_reached() {
    // 2026-08-23 fix: Airdrop has no draw to protect (payout is a
    // deterministic prize/unique_players split, not odds), so the
    // min_players lock that makes sense for SingleWinner/Podium was instead
    // a honeypot here - a creator could reach min_players with two of their
    // own wallets (refunded via ticket_revenue regardless of raffle_type,
    // see perform_draw) and permanently trap any real participant who
    // joined afterward. This is the regression test for the fix, not just
    // "withdraw still works before min_players" (already covered above).
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap(); // reaches min_players=2

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket {},
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    match &res.messages[0].msg {
        CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, "player1");
            assert_eq!(amount, &coins(1_000_000, USDC_DENOM));
        }
        other => panic!("expected BankMsg::Send, got {other:?}"),
    }

    let status = raffle_status(&deps, &env);
    assert_eq!(status.unique_player_count, 1); // back below min_players=2
    assert_eq!(status.ticket_count, 1);

    // player2 (still in) remains locked out of nothing - SingleWinner/Podium
    // are the only types this gate ever applied to, and are covered by
    // withdraw_ticket_rejects_once_min_players_is_reached above.
    execute(deps.as_mut(), env, mock_info("player2", &[]), ExecuteMsg::WithdrawTicket {}).unwrap();
}

#[test]
fn withdraw_ticket_rejects_unexpected_funds() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 3, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info("player1", &coins(1, "some_other_denom")),
        ExecuteMsg::WithdrawTicket {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn expire_raffle_rejects_before_max_raffle_age_seconds_elapses() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 3, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();

    let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::ExpireRaffle {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireRaffle {}));
}

#[test]
fn expire_raffle_rejects_once_min_players_is_reached_even_past_the_age_limit() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap(); // reaches min_players=2

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(5_184_001); // past MAX_RAFFLE_AGE_SECONDS (60 days, fixed platform-wide)
    let err = execute(deps.as_mut(), later_env, mock_info("anyone", &[]), ExecuteMsg::ExpireRaffle {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireRaffle {}));
}

#[test]
fn expire_raffle_refunds_everyone_once_stale_and_permissionless() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 3, 10, 1_000_000, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player1", 1_000_000).unwrap();
    buy_ticket(&mut deps, &env, "player2", 1_000_000).unwrap(); // 2 unique wallets, still below min_players=3

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(5_184_001); // past MAX_RAFFLE_AGE_SECONDS (60 days, fixed platform-wide)

    // Permissionless - a random wallet (not the creator) can trigger it.
    let res = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("rando", &[]),
        ExecuteMsg::ExpireRaffle {},
    )
    .unwrap();

    // prize + fee to creator, player1 (2 tickets) + player2 (1 ticket) refunded = 4 messages
    assert_eq!(res.messages.len(), 4);
    let sent_to = |addr: &str| -> Option<Vec<cosmwasm_std::Coin>> {
        res.messages.iter().find_map(|m| match &m.msg {
            CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) if to_address == addr => {
                Some(amount.clone())
            }
            _ => None,
        })
    };
    assert_eq!(sent_to("player1"), Some(coins(2_000_000, USDC_DENOM)));
    assert_eq!(sent_to("player2"), Some(coins(1_000_000, USDC_DENOM)));
    assert_eq!(sent_to("creator"), Some(coins(1000, PRIZE_DENOM)));

    let status = raffle_status(&deps, &later_env);
    assert_eq!(status.status, RaffleStatus::Cancelled);

    // Already Cancelled now, so CancelRaffle (creator) can't also fire on top of it.
    let err = execute(deps.as_mut(), later_env, mock_info("creator", &[]), ExecuteMsg::CancelRaffle {}).unwrap_err();
    assert!(matches!(err, ContractError::AlreadyCancelled {}));
}

#[test]
fn expire_raffle_rejects_unexpected_funds() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 3, 10, 1_000_000, vec![]);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::ExpireRaffle {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}
