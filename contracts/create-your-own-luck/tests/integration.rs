use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{
    coin, coins, from_json, to_json_binary, ContractResult, CosmosMsg, SystemResult, Uint128,
    WasmMsg, WasmQuery,
};
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};

use create_your_own_luck::contract::{execute, instantiate, query};
use create_your_own_luck::msg::{
    ConfigResponse, Cw20HookMsg, ExecuteMsg, InstantiateMsg, MyAirdropShareResponse, QueryMsg,
    RaffleStatusResponse, WinnersResponse,
};
use create_your_own_luck::state::{RaffleStatus, RaffleType};
use create_your_own_luck::ContractError;

const TICKET_DENOM: &str = "uusdc";
const PRIZE_DENOM: &str = "unft"; // stand-in native "prize" denom for tests
const USTC_DENOM: &str = "uustc";
const LUNC_DENOM: &str = "uluna";
const USDC_DENOM: &str = "uusdc_dex"; // deliberately distinct from ticket denom in these tests
const USTC_LUNC_POOL: &str = "ustclunc_pool";
const LUNC_USDC_POOL: &str = "luncusdc_pool";
const FEE_REFERENCE_USD_MICROS: u128 = 3_000_000; // "$3"
// With the mock reserves below, required USTC = fee_reference * 4 (see test file header math).
const EXPECTED_FEE: u128 = FEE_REFERENCE_USD_MICROS * 4;

type Deps = cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>;

fn pool_response_json(assets: &[(&str, u128)]) -> cosmwasm_std::Binary {
    let assets_json: Vec<serde_json::Value> = assets
        .iter()
        .map(|(denom, amount)| {
            serde_json::json!({
                "info": { "native_token": { "denom": denom } },
                "amount": amount.to_string(),
            })
        })
        .collect();
    let body = serde_json::json!({ "assets": assets_json, "total_share": "0" });
    to_json_binary(&body).unwrap()
}

fn setup_with_mock_dex(raffle_type: RaffleType, min_players: u32, max_players: u32, ticket_price: u128) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
    deps.querier.update_wasm(|query| match query {
        WasmQuery::Smart { contract_addr, .. } if contract_addr == USTC_LUNC_POOL => {
            SystemResult::Ok(ContractResult::Ok(pool_response_json(&[
                (USTC_DENOM, 2_000_000),
                (LUNC_DENOM, 1_000_000),
            ])))
        }
        WasmQuery::Smart { contract_addr, .. } if contract_addr == LUNC_USDC_POOL => {
            SystemResult::Ok(ContractResult::Ok(pool_response_json(&[
                (LUNC_DENOM, 1_000_000),
                (USDC_DENOM, 500_000),
            ])))
        }
        _ => SystemResult::Err(cosmwasm_std::SystemError::UnsupportedRequest {
            kind: "unmocked wasm query".to_string(),
        }),
    });

    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type,
        ticket_price: Uint128::new(ticket_price),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players,
        max_players,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        fee_reference_usd_micros: Uint128::new(FEE_REFERENCE_USD_MICROS),
        ustc_denom: USTC_DENOM.to_string(),
        lunc_denom: LUNC_DENOM.to_string(),
        usdc_denom: USDC_DENOM.to_string(),
        ustc_lunc_pool: USTC_LUNC_POOL.to_string(),
        lunc_usdc_pool: LUNC_USDC_POOL.to_string(),
        founder_fee_address: "founder".to_string(),
        treasury_address: "treasury".to_string(),
        burn_address: "burn".to_string(),
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    (deps, env)
}

fn deposit_prize(deps: &mut Deps, env: &cosmwasm_std::Env, prize_amount: u128, fee_sent: u128) -> Result<cosmwasm_std::Response, ContractError> {
    let mut funds = coins(prize_amount, PRIZE_DENOM);
    funds.push(cosmwasm_std::coin(fee_sent, USTC_DENOM));
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

#[test]
fn podium_requires_at_least_three_min_players() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        fee_reference_usd_micros: Uint128::new(FEE_REFERENCE_USD_MICROS),
        ustc_denom: USTC_DENOM.to_string(),
        lunc_denom: LUNC_DENOM.to_string(),
        usdc_denom: USDC_DENOM.to_string(),
        ustc_lunc_pool: USTC_LUNC_POOL.to_string(),
        lunc_usdc_pool: LUNC_USDC_POOL.to_string(),
        founder_fee_address: "founder".to_string(),
        treasury_address: "treasury".to_string(),
        burn_address: "burn".to_string(),
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PodiumNeedsThreePlayers {}));
}

#[test]
fn deposit_prize_quotes_the_dex_fee_and_refunds_overpayment() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 2, 0);

    let err = deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE - 1).unwrap_err();
    assert!(matches!(err, ContractError::WrongFeePayment { .. }));

    let res = deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE + 500).unwrap();
    assert_eq!(res.messages.len(), 1); // refund of the 500 overpayment
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "creator");
        assert_eq!(amount, &coins(500, USTC_DENOM));
    } else {
        panic!("expected a refund BankMsg::Send");
    }

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Open);
    assert_eq!(status.prize_amount, Uint128::new(1000));
}

#[test]
fn only_creator_can_deposit_prize_and_only_once() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 2, 0);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("not-creator", &coins(1000, PRIZE_DENOM)),
        ExecuteMsg::DepositPrize {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();
    let err = deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap_err();
    assert!(matches!(err, ContractError::AlreadyFunded {}));
}

#[test]
fn free_ticket_raffle_lets_anyone_enter_without_funds() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 2, 0);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();

    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let res = buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "true"));

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Closed);
    assert_eq!(status.unique_player_count, 2);
}

#[test]
fn allowlist_rejects_wallets_not_on_the_list() {
    let mut deps = mock_dependencies();
    deps.querier.update_wasm(|query| match query {
        WasmQuery::Smart { contract_addr, .. } if contract_addr == USTC_LUNC_POOL => {
            SystemResult::Ok(ContractResult::Ok(pool_response_json(&[(USTC_DENOM, 2_000_000), (LUNC_DENOM, 1_000_000)])))
        }
        WasmQuery::Smart { contract_addr, .. } if contract_addr == LUNC_USDC_POOL => {
            SystemResult::Ok(ContractResult::Ok(pool_response_json(&[(LUNC_DENOM, 1_000_000), (USDC_DENOM, 500_000)])))
        }
        _ => SystemResult::Err(cosmwasm_std::SystemError::UnsupportedRequest { kind: "unmocked".to_string() }),
    });
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: Some(vec!["allowed1".to_string()]),
        min_players: 2,
        max_players: 2,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        fee_reference_usd_micros: Uint128::new(FEE_REFERENCE_USD_MICROS),
        ustc_denom: USTC_DENOM.to_string(),
        lunc_denom: LUNC_DENOM.to_string(),
        usdc_denom: USDC_DENOM.to_string(),
        ustc_lunc_pool: USTC_LUNC_POOL.to_string(),
        lunc_usdc_pool: LUNC_USDC_POOL.to_string(),
        founder_fee_address: "founder".to_string(),
        treasury_address: "treasury".to_string(),
        burn_address: "burn".to_string(),
    };
    instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), msg).unwrap();
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();

    let err = buy_ticket(&mut deps, &env, "not-allowed", 0).unwrap_err();
    assert!(matches!(err, ContractError::NotAllowed {}));
    buy_ticket(&mut deps, &env, "allowed1", 0).unwrap();
}

#[test]
fn single_winner_pays_the_full_prize_and_ticket_revenue_and_fee_split() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 2, 100);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    // 1 prize payout + 1 ticket-revenue-to-creator + 3 fee-split payouts = 5
    assert_eq!(res.messages.len(), 5);

    let winners_bin = query(deps.as_ref(), later_env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 1);
    assert_eq!(winners.prize_shares, vec![Uint128::new(1000)]);
}

#[test]
fn draw_winner_past_the_window_rearms_instead_of_drawing() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 2, 100);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap(); // auto-closes, draw_after_height = height + 5, window width 10

    let mut too_late_env = env.clone();
    too_late_env.block.height += 15; // first height past the ceiling
    let res = execute(deps.as_mut(), too_late_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "rearm_draw_window");
    assert!(res.messages.is_empty());

    let status = raffle_status(&deps, &too_late_env);
    assert_eq!(status.status, RaffleStatus::Closed);
    assert_eq!(status.draw_after_height, Some(too_late_env.block.height + 5));

    let err = execute(deps.as_mut(), too_late_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::DrawTooEarly { .. }));

    let mut drawable_env = too_late_env.clone();
    drawable_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), drawable_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    assert_eq!(draw_res.attributes.iter().find(|a| a.key == "action").unwrap().value, "draw_winner");
    let winners_bin = query(deps.as_ref(), drawable_env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 1);
}

#[test]
fn podium_picks_three_distinct_winners_split_50_30_20() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::Podium, 3, 3, 0);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    let winners_bin = query(deps.as_ref(), later_env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 3);
    let unique: std::collections::BTreeSet<_> = winners.winners.iter().collect();
    assert_eq!(unique.len(), 3, "all three podium places must be distinct wallets");
    assert_eq!(winners.prize_shares, vec![Uint128::new(500), Uint128::new(300), Uint128::new(200)]);
}

#[test]
fn airdrop_splits_equally_and_supports_claim_and_reclaim() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::Airdrop, 2, 2, 0);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    // no per-winner prize payout for Airdrop itself (that's pulled later via
    // ClaimAirdropShare); the 3 messages here are the founder/treasury/burn fee split.
    assert_eq!(res.messages.len(), 3);

    let share_bin = query(deps.as_ref(), later_env.clone(), QueryMsg::GetMyAirdropShare { wallet: "player1".to_string() }).unwrap();
    let share: MyAirdropShareResponse = from_json(share_bin).unwrap();
    assert_eq!(share.share, Uint128::new(500));
    assert!(!share.claimed);

    execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap();
    let err = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::ClaimAirdropShare {}).unwrap_err();
    assert!(matches!(err, ContractError::AlreadyClaimed {}));

    // player2 never claims; creator reclaims after the deadline.
    let mut after_deadline_env = later_env.clone();
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
fn cancel_raffle_refunds_prize_fee_and_tickets() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 3, 100);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();

    let res = execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CancelRaffle {}).unwrap();
    // prize refund + fee refund + player1's ticket refund = 3
    assert_eq!(res.messages.len(), 3);

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Cancelled);
}

#[test]
fn get_config_returns_the_instantiate_settings() {
    let (deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 6, 0);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.max_players, 6);
    assert_eq!(config.min_players, 2);
    assert_eq!(config.raffle_type, RaffleType::SingleWinner);
}

fn instantiate_with_prize(
    prize_native_denom: Option<&str>,
    prize_cw20_address: Option<&str>,
) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
    deps.querier.update_wasm(|query| match query {
        WasmQuery::Smart { contract_addr, .. } if contract_addr == USTC_LUNC_POOL => {
            SystemResult::Ok(ContractResult::Ok(pool_response_json(&[
                (USTC_DENOM, 2_000_000),
                (LUNC_DENOM, 1_000_000),
            ])))
        }
        WasmQuery::Smart { contract_addr, .. } if contract_addr == LUNC_USDC_POOL => {
            SystemResult::Ok(ContractResult::Ok(pool_response_json(&[
                (LUNC_DENOM, 1_000_000),
                (USDC_DENOM, 500_000),
            ])))
        }
        _ => SystemResult::Err(cosmwasm_std::SystemError::UnsupportedRequest {
            kind: "unmocked wasm query".to_string(),
        }),
    });
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 2,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: prize_native_denom.map(|s| s.to_string()),
        prize_cw20_address: prize_cw20_address.map(|s| s.to_string()),
        fee_reference_usd_micros: Uint128::new(FEE_REFERENCE_USD_MICROS),
        ustc_denom: USTC_DENOM.to_string(),
        lunc_denom: LUNC_DENOM.to_string(),
        usdc_denom: USDC_DENOM.to_string(),
        ustc_lunc_pool: USTC_LUNC_POOL.to_string(),
        lunc_usdc_pool: LUNC_USDC_POOL.to_string(),
        founder_fee_address: "founder".to_string(),
        treasury_address: "treasury".to_string(),
        burn_address: "burn".to_string(),
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
        mock_info("creator", &coins(EXPECTED_FEE, USTC_DENOM)),
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
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env, mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

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
fn native_prize_same_denom_as_ustc_fee_needs_pay_service_fee_first() {
    let (mut deps, env) = instantiate_with_prize(Some(USTC_DENOM), None);

    // Sending prize + fee combined in one DepositPrize call can't work here -
    // there'd be no way to tell how much of the single uustc coin is which.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &[coin(1000, USTC_DENOM)]),
        ExecuteMsg::DepositPrize {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::MustPayServiceFeeSeparately {}));

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(EXPECTED_FEE, USTC_DENOM)),
        ExecuteMsg::PayServiceFee {},
    )
    .unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &coins(1000, USTC_DENOM)),
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
    let mut deps = mock_dependencies();
    let env = mock_env();
    let base_msg = |min_players: u32, max_players: u32| InstantiateMsg {
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players,
        max_players,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        fee_reference_usd_micros: Uint128::new(FEE_REFERENCE_USD_MICROS),
        ustc_denom: USTC_DENOM.to_string(),
        lunc_denom: LUNC_DENOM.to_string(),
        usdc_denom: USDC_DENOM.to_string(),
        ustc_lunc_pool: USTC_LUNC_POOL.to_string(),
        lunc_usdc_pool: LUNC_USDC_POOL.to_string(),
        founder_fee_address: "founder".to_string(),
        treasury_address: "treasury".to_string(),
        burn_address: "burn".to_string(),
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}

#[test]
fn ticket_cap_per_wallet_is_half_of_max_players_minimum_one() {
    let (mut deps, env) = setup_with_mock_dex(RaffleType::SingleWinner, 2, 4, 0);
    deposit_prize(&mut deps, &env, 1000, EXPECTED_FEE).unwrap();

    // max_players=4 -> cap = max(1, 4/2) = 2.
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let err = buy_ticket(&mut deps, &env, "player1", 0).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));
}
