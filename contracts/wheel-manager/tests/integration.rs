use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coin, coins, from_json, CosmosMsg, Uint128, WasmMsg};

use wheel_manager::contract::{execute, instantiate, query};
use wheel_manager::msg::{ConfigResponse, ExecuteMsg, InstantiateMsg, MyWinningsResponse, QueryMsg, RoundResponse};
use wheel_manager::state::RoundStatus;
use wheel_manager::ContractError;

const TICKET_DENOM: &str = "uusdc";
const REDEMPTION_DENOM: &str = "uustc";
const TICKET_PRICE: u128 = 1_000_000;

fn setup(max_players: u32, min_players: u32) -> (cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        ticket_price: Uint128::new(TICKET_PRICE),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players,
        max_players,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        unclaimed_deadline_days: 90,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        weekly_round_address: "weeklyround".to_string(),
    };
    let info = mock_info("admin", &[]);
    instantiate(deps.as_mut(), env.clone(), info, msg).unwrap();
    (deps, env)
}

fn buy_ticket(
    deps: &mut cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >,
    env: &cosmwasm_std::Env,
    sender: &str,
) -> Result<cosmwasm_std::Response, ContractError> {
    let info = mock_info(sender, &coins(TICKET_PRICE, TICKET_DENOM));
    execute(deps.as_mut(), env.clone(), info, ExecuteMsg::BuyTicket {})
}

fn current_round(
    deps: &cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >,
    env: &cosmwasm_std::Env,
) -> RoundResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetCurrentRound {}).unwrap();
    from_json(bin).unwrap()
}

#[test]
fn wrong_ticket_amount_is_rejected() {
    let (mut deps, env) = setup(3, 2);
    let info = mock_info("player1", &coins(TICKET_PRICE - 1, TICKET_DENOM));
    let err = execute(deps.as_mut(), env, info, ExecuteMsg::BuyTicket {}).unwrap_err();
    assert!(matches!(err, ContractError::WrongTicketPayment { .. }));
}

#[test]
fn multiple_tickets_from_the_same_wallet_count_as_one_player() {
    // max_players=6 -> ticket cap per wallet is max(1, 6/2) = 3, just enough
    // for this test to buy 3 tickets from the same wallet.
    let (mut deps, env) = setup(6, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let round = current_round(&deps, &env);
    assert_eq!(round.ticket_count, 3);
    assert_eq!(round.unique_player_count, 1);
    assert_eq!(round.status, RoundStatus::Open); // max_players=6 unique wallets, only 1 so far
    assert_eq!(round.pool, Uint128::new(TICKET_PRICE * 3));
}

#[test]
fn ticket_cap_per_wallet_is_half_of_max_players_minimum_one() {
    // max_players=4 -> cap = max(1, 4/2) = 2.
    let (mut deps, env) = setup(4, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();
    let err = buy_ticket(&mut deps, &env, "player1").unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));

    // A different wallet is unaffected by player1's cap.
    buy_ticket(&mut deps, &env, "player2").unwrap();

    // max_players=2 -> cap = max(1, 2/2) = 1 (the floor never goes to zero).
    let (mut deps2, env2) = setup(2, 2);
    buy_ticket(&mut deps2, &env2, "player1").unwrap();
    let err = buy_ticket(&mut deps2, &env2, "player1").unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 1 }));
}

#[test]
fn reaching_max_unique_players_auto_closes_in_the_same_call() {
    let (mut deps, env) = setup(2, 2);
    let res1 = buy_ticket(&mut deps, &env, "player1").unwrap();
    assert!(res1.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "false"));

    let res2 = buy_ticket(&mut deps, &env, "player2").unwrap();
    assert!(res2.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "true"));

    let round = current_round(&deps, &env);
    assert_eq!(round.status, RoundStatus::Closed);
    assert!(round.draw_after_height.is_some());

    // Round is closed now, no more tickets accepted.
    let err = buy_ticket(&mut deps, &env, "player3").unwrap_err();
    assert!(matches!(err, ContractError::RoundNotOpen {}));
}

#[test]
fn close_round_before_max_or_timeout_fails() {
    let (mut deps, env) = setup(3, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));
}

#[test]
fn close_round_after_timeout_with_min_players_succeeds() {
    let (mut deps, env) = setup(5, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(3601);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let round = current_round(&deps, &later_env);
    assert_eq!(round.status, RoundStatus::Closed);
}

#[test]
fn draw_winner_before_delay_fails_then_succeeds_and_splits_correctly() {
    let (mut deps, env) = setup(2, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // auto-closes, draw_after_height = height + 5

    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::DrawTooEarly { .. }));

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    let winner_attr = res.attributes.iter().find(|a| a.key == "winner").unwrap();
    assert!(winner_attr.value == "player1" || winner_attr.value == "player2");

    let prize_attr = res.attributes.iter().find(|a| a.key == "prize").unwrap();
    // pool = 2_000_000 -> 60% prize = 1_200_000
    assert_eq!(prize_attr.value, "1200000");

    // treasury (12% + dust) + admin (3%) BankMsg::Send, + weekly (20%) WasmMsg::Execute
    assert_eq!(res.messages.len(), 3);
    let has_weekly_wasm_call = res.messages.iter().any(|m| matches!(&m.msg, CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, .. }) if contract_addr == "weeklyround"));
    assert!(has_weekly_wasm_call);

    // Round 1 is Drawn, round 2 was opened automatically.
    let round1 = query(deps.as_ref(), later_env.clone(), QueryMsg::GetRoundHistory { round_id: 1 }).unwrap();
    let round1: RoundResponse = from_json(round1).unwrap();
    assert_eq!(round1.status, RoundStatus::Drawn);
    assert_eq!(round1.prize_remaining, Uint128::new(1_200_000));

    let round2 = current_round(&deps, &later_env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);
    // 5% of 2_000_000 = 100_000 carried into round 2's pool
    assert_eq!(round2.pool, Uint128::new(100_000));
}

#[test]
fn only_the_winner_can_redeem_and_overpay_is_refunded() {
    let (mut deps, env) = setup(2, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();
    let loser = if winner == "player1" { "player2" } else { "player1" };

    // Non-winner cannot redeem.
    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&loser, &coins(1_200_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotWinner { .. }));

    // Winner overpays (sends more USTC than the remaining prize) -> gets change back.
    let redeem_res = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&winner, &coins(2_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap();
    assert_eq!(redeem_res.messages.len(), 2); // payout + refund
    let payout_attr = redeem_res.attributes.iter().find(|a| a.key == "payout").unwrap();
    let refund_attr = redeem_res.attributes.iter().find(|a| a.key == "refund").unwrap();
    assert_eq!(payout_attr.value, "1200000");
    assert_eq!(refund_attr.value, "800000");

    // Prize fully redeemed -> nothing left, winnings index cleared.
    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&winner, &coins(1, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NothingToRedeem { .. }));

    let winnings_bin = query(
        deps.as_ref(),
        later_env.clone(),
        QueryMsg::GetMyWinnings { wallet: winner.clone() },
    )
    .unwrap();
    let winnings: MyWinningsResponse = from_json(winnings_bin).unwrap();
    assert!(winnings.winnings.is_empty());
}

#[test]
fn partial_redeem_keeps_the_wallet_in_the_winnings_index() {
    let (mut deps, env) = setup(2, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();

    execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&winner, &coins(500_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap();

    let winnings_bin = query(
        deps.as_ref(),
        later_env.clone(),
        QueryMsg::GetMyWinnings { wallet: winner.clone() },
    )
    .unwrap();
    let winnings: MyWinningsResponse = from_json(winnings_bin).unwrap();
    assert_eq!(winnings.winnings.len(), 1);
    assert_eq!(winnings.winnings[0].prize_remaining, Uint128::new(700_000));
}

#[test]
fn admin_only_actions_reject_non_admin() {
    let (mut deps, env) = setup(2, 2);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("not-admin", &[]),
        ExecuteMsg::SweepUstc {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

#[test]
fn sweep_expired_prize_is_permissionless_but_gated_by_the_deadline() {
    let (mut deps, env) = setup(2, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    // Too early - default unclaimed_deadline_days is 90.
    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    // 90+ days later, ANYONE (not just admin) can trigger the sweep.
    let mut expired_env = later_env.clone();
    expired_env.block.time = expired_env.block.time.plus_seconds(91 * 86400);
    let res = execute(
        deps.as_mut(),
        expired_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { round_id: 1 },
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(1_200_000, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }

    // The prize is gone now - the original winner can no longer redeem it,
    // and a second sweep attempt finds nothing left.
    let round1 = query(deps.as_ref(), expired_env.clone(), QueryMsg::GetRoundHistory { round_id: 1 }).unwrap();
    let round1: RoundResponse = from_json(round1).unwrap();
    assert_eq!(round1.prize_remaining, Uint128::zero());

    let err = execute(
        deps.as_mut(),
        expired_env,
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NothingToRedeem { .. }));
}

#[test]
fn sweep_ustc_moves_the_contracts_redemption_denom_balance_to_treasury() {
    let (mut deps, env) = setup(2, 2);
    deps.querier
        .update_balance(env.contract.address.clone(), coins(42, REDEMPTION_DENOM));

    let res = execute(deps.as_mut(), env, mock_info("admin", &[]), ExecuteMsg::SweepUstc {}).unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(42, REDEMPTION_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }
}

#[test]
fn get_config_returns_the_instantiate_settings() {
    let (deps, env) = setup(7, 3);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.max_players, 7);
    assert_eq!(config.min_players, 3);
    assert_eq!(config.ticket_price, Uint128::new(TICKET_PRICE));
    assert_eq!(config.ticket_denom, TICKET_DENOM);
    assert_eq!(config.redemption_denom, REDEMPTION_DENOM);
}

#[test]
fn buy_ticket_with_extra_unrelated_denom_attached_is_still_rejected_if_price_wrong() {
    let (mut deps, env) = setup(3, 2);
    let info = mock_info("player1", &[coin(TICKET_PRICE, "someotherdenom")]);
    let err = execute(deps.as_mut(), env, info, ExecuteMsg::BuyTicket {}).unwrap_err();
    assert!(matches!(err, ContractError::WrongTicketPayment { .. }));
}

#[test]
fn instantiate_rejects_degenerate_player_bounds() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let base_msg = |min_players: u32, max_players: u32| InstantiateMsg {
        ticket_price: Uint128::new(TICKET_PRICE),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players,
        max_players,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        unclaimed_deadline_days: 90,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        weekly_round_address: "weeklyround".to_string(),
    };

    // min_players = 0 would let a round close/draw with zero entrants, which
    // panics in the winner-picking modulo - must be rejected up front.
    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    // max_players < min_players is nonsensical (the round could never reach
    // enough unique players to satisfy the max-based auto-close path).
    let err = instantiate(deps.as_mut(), env, mock_info("admin", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}
