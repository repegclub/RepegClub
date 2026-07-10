use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coins, from_json, CosmosMsg, Uint128};

use weekly_round::contract::{execute, instantiate, query};
use weekly_round::msg::{
    ConfigResponse, ExecuteMsg, InstantiateMsg, MyWinningsResponse, QueryMsg, TodayPriceResponse,
    WeekResponse,
};
use weekly_round::state::RoundStatus;
use weekly_round::ContractError;

const TICKET_DENOM: &str = "uusdc";
const REDEMPTION_DENOM: &str = "uustc";
const BASE_PRICE: u128 = 10_000_000; // 10 "USDC"
const INCREMENT: u128 = 1_000_000; // +1 "USDC" per day

type Deps = cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>;

fn setup(max_players: u32, min_players: u32, round_duration_days: u64) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        base_ticket_price: Uint128::new(BASE_PRICE),
        price_increment_per_day: Uint128::new(INCREMENT),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players,
        max_players,
        round_duration_days,
        draw_delay_blocks: 5,
        unclaimed_deadline_days: 90,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
    };
    let info = mock_info("admin", &[]);
    instantiate(deps.as_mut(), env.clone(), info, msg).unwrap();
    (deps, env)
}

fn current_week(deps: &Deps, env: &cosmwasm_std::Env) -> WeekResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetCurrentWeek {}).unwrap();
    from_json(bin).unwrap()
}

fn buy_at_price(
    deps: &mut Deps,
    env: &cosmwasm_std::Env,
    sender: &str,
    price: u128,
) -> Result<cosmwasm_std::Response, ContractError> {
    let info = mock_info(sender, &coins(price, TICKET_DENOM));
    execute(deps.as_mut(), env.clone(), info, ExecuteMsg::BuyWeeklyTicket {})
}

#[test]
fn today_price_rises_with_elapsed_days() {
    let (deps, env) = setup(5, 2, 7);
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetTodayPrice {}).unwrap();
    let day0: TodayPriceResponse = from_json(bin).unwrap();
    assert_eq!(day0.price, Uint128::new(BASE_PRICE));

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(3 * 86400 + 10);
    let bin = query(deps.as_ref(), later_env, QueryMsg::GetTodayPrice {}).unwrap();
    let day3: TodayPriceResponse = from_json(bin).unwrap();
    assert_eq!(day3.price, Uint128::new(BASE_PRICE + 3 * INCREMENT));
}

#[test]
fn wrong_ticket_amount_is_rejected() {
    let (mut deps, env) = setup(5, 2, 7);
    let err = buy_at_price(&mut deps, &env, "player1", BASE_PRICE - 1).unwrap_err();
    assert!(matches!(err, ContractError::WrongTicketPayment { .. }));
}

#[test]
fn multiple_tickets_from_the_same_wallet_count_as_one_player() {
    // max_players=4 -> ticket cap per wallet is max(1, 4/2) = 2.
    let (mut deps, env) = setup(4, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let week = current_week(&deps, &env);
    assert_eq!(week.ticket_count, 2);
    assert_eq!(week.unique_player_count, 1);
    assert_eq!(week.status, RoundStatus::Open);
}

#[test]
fn ticket_cap_per_wallet_is_half_of_max_players_minimum_one() {
    let (mut deps, env) = setup(4, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    let err = buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));
}

#[test]
fn reaching_max_unique_players_auto_closes_in_the_same_call() {
    let (mut deps, env) = setup(2, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    let res2 = buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();
    assert!(res2.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "true"));

    let week = current_week(&deps, &env);
    assert_eq!(week.status, RoundStatus::Closed);

    let err = buy_at_price(&mut deps, &env, "player3", BASE_PRICE).unwrap_err();
    assert!(matches!(err, ContractError::WeekNotOpen {}));
}

#[test]
fn close_week_before_max_or_duration_fails() {
    let (mut deps, env) = setup(5, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::CloseWeek {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseWeek {}));
}

#[test]
fn close_week_after_duration_with_min_players_succeeds() {
    let (mut deps, env) = setup(5, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::CloseWeek {}).unwrap();

    let week = current_week(&deps, &later_env);
    assert_eq!(week.status, RoundStatus::Closed);
}

#[test]
fn draw_weekly_winner_splits_85_12_3_and_includes_wheel_contributions() {
    let (mut deps, env) = setup(2, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    // A Wheel Manager (or anyone) contributes to this week's pool before it closes.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("some-wheel-manager", &coins(4_000_000, TICKET_DENOM)),
        ExecuteMsg::ContributeToPool {
            source_wheel: "some-wheel-manager".to_string(),
            source_round_id: 7,
        },
    )
    .unwrap();

    // Second ticket closes the week (max_players=2).
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::DrawTooEarly { .. }));

    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap();

    // gross = 2*10_000_000 (tickets) + 4_000_000 (contribution) = 24_000_000
    let prize_attr = res.attributes.iter().find(|a| a.key == "prize").unwrap();
    assert_eq!(prize_attr.value, "20400000"); // 85% of 24_000_000

    assert_eq!(res.messages.len(), 2); // treasury + admin, no cross-contract call
    let treasury_msg = res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) if to_address == "treasury" => {
            Some(amount[0].amount)
        }
        _ => None,
    });
    assert_eq!(treasury_msg, Some(Uint128::new(2_880_000))); // 12% of 24_000_000

    let week1 = query(deps.as_ref(), later_env.clone(), QueryMsg::GetWeekHistory { week_id: 1 }).unwrap();
    let week1: WeekResponse = from_json(week1).unwrap();
    assert_eq!(week1.status, RoundStatus::Drawn);
    assert_eq!(week1.wheel_contributions, Uint128::new(4_000_000));

    let week2 = current_week(&deps, &later_env);
    assert_eq!(week2.week_id, 2);
    assert_eq!(week2.status, RoundStatus::Open);
}

#[test]
fn only_the_winner_can_redeem_and_overpay_is_refunded() {
    let (mut deps, env) = setup(2, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();
    let loser = if winner == "player1" { "player2" } else { "player1" };

    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(loser, &coins(17_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotWinner { .. }));

    // prize = 85% of 20_000_000 = 17_000_000
    let redeem_res = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&winner, &coins(20_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { week_id: 1 },
    )
    .unwrap();
    assert_eq!(redeem_res.messages.len(), 2);
    let payout_attr = redeem_res.attributes.iter().find(|a| a.key == "payout").unwrap();
    let refund_attr = redeem_res.attributes.iter().find(|a| a.key == "refund").unwrap();
    assert_eq!(payout_attr.value, "17000000");
    assert_eq!(refund_attr.value, "3000000");

    let winnings_bin = query(
        deps.as_ref(),
        later_env,
        QueryMsg::GetMyWinnings { wallet: winner },
    )
    .unwrap();
    let winnings: MyWinningsResponse = from_json(winnings_bin).unwrap();
    assert!(winnings.winnings.is_empty());
}

#[test]
fn admin_only_actions_reject_non_admin() {
    let (mut deps, env) = setup(2, 2, 7);
    let err = execute(deps.as_mut(), env, mock_info("not-admin", &[]), ExecuteMsg::SweepUstc {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

#[test]
fn sweep_expired_prize_is_permissionless_but_gated_by_the_deadline() {
    let (mut deps, env) = setup(2, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap();

    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    let mut expired_env = later_env.clone();
    expired_env.block.time = expired_env.block.time.plus_seconds(91 * 86400);
    let res = execute(
        deps.as_mut(),
        expired_env,
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { week_id: 1 },
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(17_000_000, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }
}

#[test]
fn sweep_ustc_moves_the_contracts_redemption_denom_balance_to_treasury() {
    let (mut deps, env) = setup(2, 2, 7);
    deps.querier
        .update_balance(env.contract.address.clone(), coins(99, REDEMPTION_DENOM));

    let res = execute(deps.as_mut(), env, mock_info("admin", &[]), ExecuteMsg::SweepUstc {}).unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(99, REDEMPTION_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }
}

#[test]
fn get_config_returns_the_instantiate_settings() {
    let (deps, env) = setup(9, 4, 10);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.max_players, 9);
    assert_eq!(config.min_players, 4);
    assert_eq!(config.round_duration_days, 10);
    assert_eq!(config.base_ticket_price, Uint128::new(BASE_PRICE));
}

#[test]
fn instantiate_rejects_degenerate_player_bounds() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let base_msg = |min_players: u32, max_players: u32| InstantiateMsg {
        base_ticket_price: Uint128::new(BASE_PRICE),
        price_increment_per_day: Uint128::new(INCREMENT),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players,
        max_players,
        round_duration_days: 7,
        draw_delay_blocks: 5,
        unclaimed_deadline_days: 90,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    let err = instantiate(deps.as_mut(), env, mock_info("admin", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}
