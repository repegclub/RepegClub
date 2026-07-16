use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coins, from_json, CosmosMsg, Uint128};

use weekly_round::contract::{execute, instantiate, query};
use weekly_round::msg::{
    ConfigResponse, EntrantsResponse, ExecuteMsg, InstantiateMsg, MyWinningsResponse, QueryMsg,
    TodayPriceResponse, WalletStatsResponse, WeekResponse,
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
        draw_window_blocks: 10,
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
fn get_week_entrants_returns_one_entry_per_ticket_including_duplicates() {
    let (mut deps, env) = setup(6, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let week = current_week(&deps, &env);
    let bin = query(
        deps.as_ref(),
        env,
        QueryMsg::GetWeekEntrants { week_id: week.week_id },
    )
    .unwrap();
    let resp: EntrantsResponse = from_json(bin).unwrap();
    assert_eq!(
        resp.entrants.iter().map(|a| a.as_str()).collect::<Vec<_>>(),
        vec!["player1", "player1", "player2"]
    );
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
fn draw_weekly_winner_past_the_window_rearms_instead_of_drawing() {
    let (mut deps, env) = setup(2, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // auto-closes, draw_after_height = height + 5, window width 10

    let mut too_late_env = env.clone();
    too_late_env.block.height += 15; // first height past the ceiling
    let res = execute(deps.as_mut(), too_late_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap();

    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "rearm_draw_window");
    assert!(res.messages.is_empty());

    let week = current_week(&deps, &too_late_env);
    assert_eq!(week.status, RoundStatus::Closed);
    assert_eq!(week.draw_after_height, Some(too_late_env.block.height + 5));
    assert_eq!(week.winner, None);

    let err = execute(deps.as_mut(), too_late_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::DrawTooEarly { .. }));

    let mut drawable_env = too_late_env.clone();
    drawable_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), drawable_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap();
    assert_eq!(draw_res.attributes.iter().find(|a| a.key == "action").unwrap().value, "draw_weekly_winner");
    let week1 = query(deps.as_ref(), drawable_env.clone(), QueryMsg::GetWeekHistory { week_id: 1 }).unwrap();
    let week1: WeekResponse = from_json(week1).unwrap();
    assert_eq!(week1.status, RoundStatus::Drawn);
    assert!(week1.winner.is_some());
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
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    let err = instantiate(deps.as_mut(), env, mock_info("admin", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}

#[test]
fn buy_ticket_is_rejected_once_the_week_is_stale_without_min_players() {
    let (mut deps, env) = setup(5, 3, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    let err = buy_at_price(&mut deps, &later_env, "player2", BASE_PRICE + 7 * INCREMENT).unwrap_err();
    assert!(matches!(err, ContractError::WeekExpired {}));
}

#[test]
fn expire_week_fails_too_early_or_once_min_players_is_reached() {
    let (mut deps, env) = setup(5, 3, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {})
        .unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireWeek {}));

    let (mut deps2, env2) = setup(5, 2, 7);
    buy_at_price(&mut deps2, &env2, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps2, &env2, "player2", BASE_PRICE).unwrap();
    let mut later_env2 = env2.clone();
    later_env2.block.time = later_env2.block.time.plus_seconds(7 * 86400 + 1);
    let err = execute(deps2.as_mut(), later_env2, mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {})
        .unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireWeek {}));
}

#[test]
fn expire_week_lets_buyers_reclaim_exactly_what_they_paid_at_their_own_days_price() {
    let (mut deps, env) = setup(5, 3, 7);
    // player1 buys on day 0 at the base price.
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    // player2 buys 2 days later, at that day's higher ramped price - this is
    // exactly why a refund can't be derived from a single fixed ticket_price
    // like Wheel Manager does.
    let mut day2_env = env.clone();
    day2_env.block.time = day2_env.block.time.plus_seconds(2 * 86400 + 10);
    buy_at_price(&mut deps, &day2_env, "player2", BASE_PRICE + 2 * INCREMENT).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {})
        .unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "week_id" && a.value == "1"));

    let week1_bin = query(deps.as_ref(), later_env.clone(), QueryMsg::GetWeekHistory { week_id: 1 }).unwrap();
    let week1: WeekResponse = from_json(week1_bin).unwrap();
    assert_eq!(week1.status, RoundStatus::Expired);
    assert_eq!(week1.ticket_sales_pool, Uint128::new(BASE_PRICE + BASE_PRICE + 2 * INCREMENT));

    let week2 = current_week(&deps, &later_env);
    assert_eq!(week2.week_id, 2);
    assert_eq!(week2.status, RoundStatus::Open);

    let reclaim1 = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::ReclaimTicket { week_id: 1 },
    )
    .unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) = &reclaim1.messages[0].msg {
        assert_eq!(amount, &coins(BASE_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    let reclaim2 = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("player2", &[]),
        ExecuteMsg::ReclaimTicket { week_id: 1 },
    )
    .unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) = &reclaim2.messages[0].msg {
        assert_eq!(amount, &coins(BASE_PRICE + 2 * INCREMENT, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    // Can't reclaim a second time.
    let err = execute(
        deps.as_mut(),
        later_env,
        mock_info("player1", &[]),
        ExecuteMsg::ReclaimTicket { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn expire_week_carries_wheel_contributions_forward_but_not_ticket_money() {
    let (mut deps, env) = setup(5, 3, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("some-wheel-manager", &coins(4_000_000, TICKET_DENOM)),
        ExecuteMsg::ContributeToPool {
            source_wheel: "some-wheel-manager".to_string(),
            source_round_id: 1,
        },
    )
    .unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap();

    let week1_bin = query(deps.as_ref(), later_env.clone(), QueryMsg::GetWeekHistory { week_id: 1 }).unwrap();
    let week1: WeekResponse = from_json(week1_bin).unwrap();
    assert_eq!(week1.wheel_contributions, Uint128::zero());
    assert_eq!(week1.ticket_sales_pool, Uint128::new(BASE_PRICE));

    let week2 = current_week(&deps, &later_env);
    assert_eq!(week2.wheel_contributions, Uint128::new(4_000_000));
}

#[test]
fn sweep_expired_prize_also_sweeps_an_abandoned_expired_week_pool() {
    let (mut deps, env) = setup(5, 3, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap();

    let err = execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    let mut swept_env = later_env.clone();
    swept_env.block.time = swept_env.block.time.plus_seconds(91 * 86400);
    let res = execute(
        deps.as_mut(),
        swept_env.clone(),
        mock_info("randomcaller", &[]),
        ExecuteMsg::SweepExpiredPrize { week_id: 1 },
    )
    .unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(BASE_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }

    let err = execute(
        deps.as_mut(),
        swept_env,
        mock_info("player1", &[]),
        ExecuteMsg::ReclaimTicket { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

fn wallet_stats(deps: &Deps, env: &cosmwasm_std::Env, wallet: &str) -> WalletStatsResponse {
    let bin = query(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetWalletStats { wallet: wallet.to_string() },
    )
    .unwrap();
    from_json(bin).unwrap()
}

#[test]
fn withdraw_ticket_before_min_players_refunds_the_exact_amount_paid() {
    let (mut deps, env) = setup(5, 3, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap(); // 2 tickets, still below min_players=3

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket { week_id: 1 },
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "player1");
        assert_eq!(amount, &coins(BASE_PRICE * 2, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    let week = current_week(&deps, &env);
    assert_eq!(week.ticket_count, 0);
    assert_eq!(week.unique_player_count, 0);
    assert_eq!(week.ticket_sales_pool, Uint128::zero());

    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::zero());
}

#[test]
fn withdraw_ticket_is_rejected_once_min_players_is_reached() {
    let (mut deps, env) = setup(5, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player1", &[]),
        ExecuteMsg::WithdrawTicket { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::WeekAlreadyLocked { .. }));
}

#[test]
fn withdraw_ticket_rejected_for_a_wallet_with_no_tickets_in_that_week() {
    let (mut deps, env) = setup(5, 3, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info("player2", &[]),
        ExecuteMsg::WithdrawTicket { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn wallet_stats_track_total_invested_across_weeks_and_total_redeemed_net_of_overpayment() {
    let (mut deps, env) = setup(2, 2, 7);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // auto-closes week 1

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::new(BASE_PRICE));
    assert_eq!(stats.total_redeemed, Uint128::zero());

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::DrawWeeklyWinner {}).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();

    // Winner buys into week 2 too - total_invested accumulates across weeks.
    buy_at_price(&mut deps, &later_env, &winner, BASE_PRICE).unwrap();

    // Overpays the redemption; only the actual payout counts as "repegged".
    execute(
        deps.as_mut(),
        later_env.clone(),
        mock_info(&winner, &coins(20_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { week_id: 1 },
    )
    .unwrap();

    let stats = wallet_stats(&deps, &later_env, &winner);
    assert_eq!(stats.total_invested, Uint128::new(BASE_PRICE * 2));
    assert_eq!(stats.total_redeemed, Uint128::new(17_000_000));
}
