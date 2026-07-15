use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coin, coins, from_json, CosmosMsg, Uint128, WasmMsg};

use wheel_manager::contract::{execute, instantiate, query};
use wheel_manager::msg::{
    ConfigResponse, EntrantsResponse, ExecuteMsg, InstantiateMsg, MyWinningsResponse, QueryMsg,
    RoundResponse, WalletStatsResponse,
};
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
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        max_round_age_seconds: 172_800, // 48h
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
fn buying_a_ticket_after_min_players_resets_the_close_deadline() {
    let (mut deps, env) = setup(5, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // min_players reached, deadline = opened_at + 3600

    // Almost at the original deadline - one more ticket resets it forward.
    let mut almost_env = env.clone();
    almost_env.block.time = almost_env.block.time.plus_seconds(3599);
    buy_ticket(&mut deps, &almost_env, "player3").unwrap(); // new deadline = opened_at + 7199

    // The *original* deadline has now passed, but the reset one hasn't.
    let mut still_too_early = env.clone();
    still_too_early.block.time = still_too_early.block.time.plus_seconds(3601);
    let err = execute(deps.as_mut(), still_too_early, mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));

    // Once the *reset* deadline passes, it can finally close.
    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7200);
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
    // draw_height is the exact height the winner-picking hash used, not just
    // the minimum required draw_after_height - needed for round verification.
    assert_eq!(round1.draw_height, Some(later_env.block.height));

    let round2 = current_round(&deps, &later_env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);
    // 5% of 2_000_000 = 100_000 carried into round 2's pool
    assert_eq!(round2.pool, Uint128::new(100_000));
}

#[test]
fn draw_winner_past_the_window_rearms_instead_of_drawing() {
    let (mut deps, env) = setup(2, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // auto-closes, draw_after_height = height + 5, window width 10

    // height + 5 (required) + 10 (window) = height + 15 is the first height
    // past the ceiling.
    let mut too_late_env = env.clone();
    too_late_env.block.height += 15;
    let res = execute(deps.as_mut(), too_late_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "rearm_draw_window");
    assert!(res.messages.is_empty());

    // Round is still Closed, not Drawn - and got a fresh draw_after_height
    // based on the height the rearm happened at, not the original one.
    let round = current_round(&deps, &too_late_env);
    assert_eq!(round.status, RoundStatus::Closed);
    assert_eq!(round.draw_after_height, Some(too_late_env.block.height + 5));
    assert_eq!(round.winner, None);

    // Too early relative to the *new* window still fails normally.
    let err = execute(deps.as_mut(), too_late_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::DrawTooEarly { .. }));

    // Within the new window, drawing succeeds as normal.
    let mut drawable_env = too_late_env.clone();
    drawable_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), drawable_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    assert_eq!(draw_res.attributes.iter().find(|a| a.key == "action").unwrap().value, "draw_winner");
    let round1 = query(deps.as_ref(), drawable_env.clone(), QueryMsg::GetRoundHistory { round_id: 1 }).unwrap();
    let round1: RoundResponse = from_json(round1).unwrap();
    assert_eq!(round1.status, RoundStatus::Drawn);
    assert!(round1.winner.is_some());
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
        mock_info(loser, &coins(1_200_000, REDEMPTION_DENOM)),
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
fn get_round_entrants_returns_one_entry_per_ticket_including_duplicates() {
    let (mut deps, env) = setup(6, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let round = current_round(&deps, &env);
    let bin = query(
        deps.as_ref(),
        env,
        QueryMsg::GetRoundEntrants {
            round_id: round.round_id,
        },
    )
    .unwrap();
    let resp: EntrantsResponse = from_json(bin).unwrap();
    assert_eq!(resp.entrants.len(), 3);
    assert_eq!(
        resp.entrants.iter().filter(|a| a.as_str() == "player1").count(),
        2
    );
    assert_eq!(
        resp.entrants.iter().filter(|a| a.as_str() == "player2").count(),
        1
    );
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
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        max_round_age_seconds: 172_800,
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

#[test]
fn buy_ticket_is_rejected_once_the_round_is_stale_without_min_players() {
    let (mut deps, env) = setup(5, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(172_801); // > 48h
    let err = buy_ticket(&mut deps, &later_env, "player2").unwrap_err();
    assert!(matches!(err, ContractError::RoundExpired {}));
}

#[test]
fn expire_round_fails_too_early_or_once_min_players_is_reached() {
    let (mut deps, env) = setup(5, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    // Too early - max_round_age_seconds (48h) hasn't elapsed yet.
    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireRound {})
        .unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireRound {}));

    // A different round that did reach min_players can't be expired even
    // after the same amount of time - it should be closed/drawn normally.
    let (mut deps2, env2) = setup(5, 2);
    buy_ticket(&mut deps2, &env2, "player1").unwrap();
    buy_ticket(&mut deps2, &env2, "player2").unwrap();
    let mut later_env2 = env2.clone();
    later_env2.block.time = later_env2.block.time.plus_seconds(172_801);
    let err = execute(deps2.as_mut(), later_env2, mock_info("anyone", &[]), ExecuteMsg::ExpireRound {})
        .unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireRound {}));
}

#[test]
fn expire_round_lets_buyers_reclaim_their_own_tickets_and_opens_a_new_round() {
    let (mut deps, env) = setup(5, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(172_801);
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireRound {})
        .unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "round_id" && a.value == "1"));

    let round1_bin = query(deps.as_ref(), later_env.clone(), QueryMsg::GetRoundHistory { round_id: 1 }).unwrap();
    let round1: RoundResponse = from_json(round1_bin).unwrap();
    assert_eq!(round1.status, RoundStatus::Expired);
    assert_eq!(round1.pool, Uint128::new(TICKET_PRICE));

    // The game isn't stuck - round 2 opened automatically.
    let round2 = current_round(&deps, &later_env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);

    // A wallet that never bought a ticket in round 1 cannot reclaim from it.
    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("player2", &[]),
        ExecuteMsg::ReclaimTicket { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    let reclaim_res = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::ReclaimTicket { round_id: 1 },
    )
    .unwrap();
    assert_eq!(reclaim_res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &reclaim_res.messages[0].msg {
        assert_eq!(to_address, "player1");
        assert_eq!(amount, &coins(TICKET_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    // Can't reclaim a second time - the entry is already gone.
    let err = execute(
        deps.as_mut(),
        later_env,
        mock_info("player1", &[]),
        ExecuteMsg::ReclaimTicket { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn hard_cap_forces_close_even_while_the_rolling_deadline_keeps_getting_reset() {
    let (mut deps, env) = setup(10, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // min_players reached, rolling deadline starts

    // Long past max_round_age_seconds (48h), but someone buys a ticket here,
    // which would otherwise keep pushing the rolling deadline forward forever.
    let mut env2 = env.clone();
    env2.block.time = env2.block.time.plus_seconds(200_000);
    buy_ticket(&mut deps, &env2, "player3").unwrap();

    // CloseRound still succeeds - the hard cap overrides the rolling deadline.
    execute(deps.as_mut(), env2.clone(), mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap();
    let round = current_round(&deps, &env2);
    assert_eq!(round.status, RoundStatus::Closed);
}

#[test]
fn sweep_expired_prize_also_sweeps_an_abandoned_expired_round_pool() {
    let (mut deps, env) = setup(5, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(172_801);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireRound {}).unwrap();

    // Too early - unclaimed_deadline_days (90) measured from expired_at.
    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    let mut swept_env = later_env.clone();
    swept_env.block.time = swept_env.block.time.plus_seconds(91 * 86400);
    let res = execute(
        deps.as_mut(),
        swept_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { round_id: 1 },
    )
    .unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(TICKET_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }

    // Nothing left for player1 to reclaim once the treasury has swept it.
    let err = execute(
        deps.as_mut(),
        swept_env,
        mock_info("player1", &[]),
        ExecuteMsg::ReclaimTicket { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

fn wallet_stats(
    deps: &cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >,
    env: &cosmwasm_std::Env,
    wallet: &str,
) -> WalletStatsResponse {
    let bin = query(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetWalletStats { wallet: wallet.to_string() },
    )
    .unwrap();
    from_json(bin).unwrap()
}

#[test]
fn withdraw_ticket_before_min_players_refunds_exact_amount_and_unlocks_the_wallet() {
    let (mut deps, env) = setup(5, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap(); // 2 tickets, still below min_players=3

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket { round_id: 1 },
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "player1");
        assert_eq!(amount, &coins(TICKET_PRICE * 2, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    let round = current_round(&deps, &env);
    assert_eq!(round.ticket_count, 0);
    assert_eq!(round.unique_player_count, 0);
    assert_eq!(round.pool, Uint128::zero());

    // Nothing left to withdraw a second time.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    // Withdrawn tickets don't count as lifetime investment.
    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::zero());
}

#[test]
fn withdraw_ticket_is_rejected_once_min_players_is_reached() {
    let (mut deps, env) = setup(5, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // min_players reached, deadline live

    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::RoundAlreadyLocked { .. }));
}

#[test]
fn withdraw_ticket_rejected_for_a_wallet_with_no_tickets_in_that_round() {
    let (mut deps, env) = setup(5, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info("player2", &[]),
        ExecuteMsg::WithdrawTicket { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn wallet_stats_track_total_invested_across_rounds_and_total_redeemed_net_of_overpayment() {
    let (mut deps, env) = setup(2, 2);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // auto-closes round 1

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::new(TICKET_PRICE));
    assert_eq!(stats.total_redeemed, Uint128::zero());

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();

    // Winner buys into round 2 as well - total_invested should accumulate
    // across rounds, not reset per round.
    buy_ticket(&mut deps, &later_env, &winner).unwrap();

    // Winner overpays the redemption; only the actual payout (not the
    // refunded overpayment) should count as "repegged".
    execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&winner, &coins(2_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap();

    let stats = wallet_stats(&deps, &later_env, &winner);
    assert_eq!(stats.total_invested, Uint128::new(TICKET_PRICE * 2));
    assert_eq!(stats.total_redeemed, Uint128::new(1_200_000));
}
