use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coins, from_json, CosmosMsg, HexBinary, Uint128};
use sha2::{Digest, Sha256};

use weekly_round::contract::{execute, instantiate, query};
use weekly_round::execute::{
    open_new_week, EXPIRE_CHALLENGE_BLOCKS, EXPIRE_FINALIZE_DELAY_BLOCKS, REVEAL_PRIORITY_MARGIN_BLOCKS,
};
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
const MAX_REVEAL_AGE_SECONDS: u64 = 3600;

type Deps = cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>;

fn preimage_for(n: u8) -> HexBinary {
    HexBinary::from([n; 32])
}
fn commit_for(preimage: &HexBinary) -> HexBinary {
    HexBinary::from(Sha256::digest(preimage.as_slice()).to_vec())
}

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
        unclaimed_deadline_days: 90,
        max_reveal_age_seconds: MAX_REVEAL_AGE_SECONDS,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        commit_pusher: "committer".to_string(),
    };
    let info = mock_info("admin", &[]);
    instantiate(deps.as_mut(), env.clone(), info, msg).unwrap();
    (deps, env)
}

fn setup_and_seed(max_players: u32, min_players: u32, round_duration_days: u64, count: u8) -> (Deps, cosmwasm_std::Env) {
    let (mut deps, env) = setup(max_players, min_players, round_duration_days);
    let commits: Vec<HexBinary> = (1..=count).map(|n| commit_for(&preimage_for(n))).collect();
    execute(deps.as_mut(), env.clone(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits }).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap();
    (deps, env)
}

fn current_week(deps: &Deps, env: &cosmwasm_std::Env) -> WeekResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetCurrentWeek {}).unwrap();
    from_json(bin).unwrap()
}

fn week_history(deps: &Deps, env: &cosmwasm_std::Env, week_id: u64) -> WeekResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetWeekHistory { week_id }).unwrap();
    from_json(bin).unwrap()
}

fn buy_at_price(deps: &mut Deps, env: &cosmwasm_std::Env, sender: &str, price: u128) -> Result<cosmwasm_std::Response, ContractError> {
    let info = mock_info(sender, &coins(price, TICKET_DENOM));
    execute(deps.as_mut(), env.clone(), info, ExecuteMsg::BuyWeeklyTicket {})
}

fn reveal(deps: &mut Deps, env: &cosmwasm_std::Env, week_id: u64, n: u8) -> Result<cosmwasm_std::Response, ContractError> {
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("anyone", &[]),
        ExecuteMsg::RevealDraw { week_id, preimage: preimage_for(n) },
    )
}

fn wallet_stats(deps: &Deps, env: &cosmwasm_std::Env, wallet: &str) -> WalletStatsResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetWalletStats { wallet: wallet.to_string() }).unwrap();
    from_json(bin).unwrap()
}

// Funds check runs before any state is loaded (REVEAL_QUEUE, week status),
// so these fire on a freshly-opened week regardless - round-review fix
// (CodeRabbit, 2026-08-30): RevealDraw and the 3-phase rescue actions never
// checked attached funds at all, unlike every other message in this contract.
#[test]
fn reveal_draw_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2, 7);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::RevealDraw { week_id: 1, preimage: preimage_for(1) },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn request_expire_closed_week_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2, 7);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::RequestExpireClosedWeek { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn finalize_expire_closed_week_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2, 7);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::FinalizeExpireClosedWeek { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn claim_expired_week_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2, 7);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::ClaimExpiredWeek { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn today_price_rises_with_elapsed_days() {
    let (deps, env) = setup_and_seed(5, 2, 7, 1);
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
    let (mut deps, env) = setup_and_seed(5, 2, 7, 1);
    let err = buy_at_price(&mut deps, &env, "player1", BASE_PRICE - 1).unwrap_err();
    assert!(matches!(err, ContractError::WrongTicketPayment { .. }));
}

#[test]
fn multiple_tickets_from_the_same_wallet_count_as_one_player() {
    let (mut deps, env) = setup_and_seed(4, 2, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let week = current_week(&deps, &env);
    assert_eq!(week.ticket_count, 2);
    assert_eq!(week.unique_player_count, 1);
    assert_eq!(week.status, RoundStatus::Open);
}

#[test]
fn get_week_entrants_returns_one_entry_per_ticket_including_duplicates() {
    let (mut deps, env) = setup_and_seed(6, 2, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let week = current_week(&deps, &env);
    let bin = query(deps.as_ref(), env, QueryMsg::GetWeekEntrants { week_id: week.week_id }).unwrap();
    let resp: EntrantsResponse = from_json(bin).unwrap();
    assert_eq!(
        resp.entrants.iter().map(|a| a.as_str()).collect::<Vec<_>>(),
        vec!["player1", "player1", "player2"]
    );
}

#[test]
fn ticket_cap_per_wallet_is_half_of_max_players_minimum_one() {
    let (mut deps, env) = setup_and_seed(4, 2, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    let err = buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));
}

#[test]
fn reaching_max_unique_players_auto_closes_without_drawing() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    let res2 = buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();
    assert!(res2.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "true"));
    assert!(res2.messages.is_empty());

    let week1 = week_history(&deps, &env, 1);
    assert_eq!(week1.status, RoundStatus::Closed);
    assert!(week1.closed_at_height.is_some());

    let week2 = current_week(&deps, &env);
    assert_eq!(week2.week_id, 2);
    assert_eq!(week2.status, RoundStatus::Open);

    // Week 2 auto-consumed the next queued commit when it opened - tickets
    // go toward it now.
    buy_at_price(&mut deps, &env, "player3", BASE_PRICE).unwrap();
    assert_eq!(current_week(&deps, &env).ticket_count, 1);
}

#[test]
fn close_week_before_max_or_duration_fails() {
    let (mut deps, env) = setup_and_seed(5, 2, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::CloseWeek {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseWeek {}));
}

#[test]
fn close_week_after_duration_with_min_players_succeeds() {
    let (mut deps, env) = setup_and_seed(5, 2, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::CloseWeek {}).unwrap();

    let week1 = week_history(&deps, &later_env, 1);
    assert_eq!(week1.status, RoundStatus::Closed);
    let week2 = current_week(&deps, &later_env);
    assert_eq!(week2.status, RoundStatus::Open);
}

#[test]
fn reveal_draw_splits_85_12_3_and_includes_wheel_contributions() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    // A Wheel Manager (or anyone) contributes to this week's pool before it closes.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("some-wheel-manager", &coins(4_000_000, TICKET_DENOM)),
        ExecuteMsg::ContributeToPool { source_wheel: "some-wheel-manager".to_string(), source_round_id: 7 },
    )
    .unwrap();

    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // closes week 1

    let res = reveal(&mut deps, &env, 1, 1).unwrap();

    // gross = 2*10_000_000 (tickets) + 4_000_000 (contribution) = 24_000_000
    let prize_attr = res.attributes.iter().find(|a| a.key == "prize").unwrap();
    assert_eq!(prize_attr.value, "20400000"); // 85% of 24_000_000

    assert_eq!(res.messages.len(), 2); // treasury + admin, no cross-contract call
    let treasury_msg = res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) if to_address == "treasury" => Some(amount[0].amount),
        _ => None,
    });
    assert_eq!(treasury_msg, Some(Uint128::new(2_880_000))); // 12% of 24_000_000

    let week1 = week_history(&deps, &env, 1);
    assert_eq!(week1.status, RoundStatus::Drawn);
    assert_eq!(week1.wheel_contributions, Uint128::new(4_000_000));
    assert_eq!(week1.revealed_preimage, Some(preimage_for(1)));

    let week2 = current_week(&deps, &env);
    assert_eq!(week2.week_id, 2);
    assert_eq!(week2.status, RoundStatus::Open);
}

#[test]
fn reveal_draw_rejects_wrong_preimage() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let err = reveal(&mut deps, &env, 1, 2).unwrap_err();
    assert!(matches!(err, ContractError::BadPreimage {}));
}

#[test]
fn reveal_draw_rejects_a_week_id_that_is_not_the_queue_front() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // week 1 closes
    buy_at_price(&mut deps, &env, "player3", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player4", BASE_PRICE).unwrap(); // week 2 closes

    let err = reveal(&mut deps, &env, 2, 2).unwrap_err();
    assert!(matches!(err, ContractError::QueueMismatch { front: 1, week_id: 2 }));

    reveal(&mut deps, &env, 1, 1).unwrap();
    reveal(&mut deps, &env, 2, 2).unwrap();
}

#[test]
fn only_the_winner_can_redeem_and_overpay_is_refunded() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();
    let draw_res = reveal(&mut deps, &env, 1, 1).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();
    let loser = if winner == "player1" { "player2" } else { "player1" };

    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(loser, &coins(17_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { week_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotWinner { .. }));

    // prize = 85% of 20_000_000 = 17_000_000
    let redeem_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&winner, &coins(20_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { week_id: 1 },
    )
    .unwrap();
    assert_eq!(redeem_res.messages.len(), 2);
    let payout_attr = redeem_res.attributes.iter().find(|a| a.key == "payout").unwrap();
    let refund_attr = redeem_res.attributes.iter().find(|a| a.key == "refund").unwrap();
    assert_eq!(payout_attr.value, "17000000");
    assert_eq!(refund_attr.value, "3000000");

    let winnings_bin = query(deps.as_ref(), env, QueryMsg::GetMyWinnings { wallet: winner }).unwrap();
    let winnings: MyWinningsResponse = from_json(winnings_bin).unwrap();
    assert!(winnings.winnings.is_empty());
}

#[test]
fn admin_only_actions_reject_non_admin() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 1);
    let err = execute(deps.as_mut(), env, mock_info("not-admin", &[]), ExecuteMsg::SweepUstc {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

#[test]
fn commit_pusher_and_admin_roles_cannot_do_each_others_job() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 1);
    // admin (the instantiate sender) is not commit_pusher ("committer").
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        ExecuteMsg::PushCommits { commits: vec![commit_for(&preimage_for(9))] },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    // commit_pusher ("committer") must not be able to do anything admin-only.
    let err = execute(deps.as_mut(), env, mock_info("committer", &[]), ExecuteMsg::SweepUstc {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

#[test]
fn sweep_expired_prize_is_permissionless_but_gated_by_the_deadline() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();
    reveal(&mut deps, &env, 1, 1).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    let mut expired_env = env.clone();
    expired_env.block.time = expired_env.block.time.plus_seconds(91 * 86400);
    let res = execute(deps.as_mut(), expired_env, mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { week_id: 1 }).unwrap();
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
    let (mut deps, env) = setup_and_seed(2, 2, 7, 1);
    deps.querier.update_balance(env.contract.address.clone(), coins(99, REDEMPTION_DENOM));

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
    let (deps, env) = setup_and_seed(9, 4, 10, 1);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.max_players, 9);
    assert_eq!(config.min_players, 4);
    assert_eq!(config.round_duration_days, 10);
    assert_eq!(config.base_ticket_price, Uint128::new(BASE_PRICE));
    assert_eq!(config.max_reveal_age_seconds, MAX_REVEAL_AGE_SECONDS);
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
        unclaimed_deadline_days: 90,
        max_reveal_age_seconds: MAX_REVEAL_AGE_SECONDS,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        commit_pusher: "committer".to_string(),
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    let err = instantiate(deps.as_mut(), env, mock_info("admin", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}

#[test]
fn instantiate_rejects_out_of_bounds_max_reveal_age_seconds() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let base_msg = |max_reveal_age_seconds: u64| InstantiateMsg {
        base_ticket_price: Uint128::new(BASE_PRICE),
        price_increment_per_day: Uint128::new(INCREMENT),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players: 2,
        max_players: 5,
        round_duration_days: 7,
        unclaimed_deadline_days: 90,
        max_reveal_age_seconds,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        commit_pusher: "committer".to_string(),
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(0)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidMaxRevealAgeSeconds { .. }));
    instantiate(deps.as_mut(), env, mock_info("admin", &[]), base_msg(MAX_REVEAL_AGE_SECONDS)).unwrap();
}

#[test]
fn buy_ticket_is_rejected_before_a_commit_is_assigned() {
    let (mut deps, env) = setup(5, 3, 7);
    let err = buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap_err();
    assert!(matches!(err, ContractError::WeekNotSeeded {}));
}

#[test]
fn open_new_week_rejects_a_week_id_that_already_exists() {
    let (mut deps, env) = setup(5, 3, 7);
    let err = open_new_week(deps.as_mut().storage, &env, 1).unwrap_err();
    assert!(matches!(err, ContractError::WeekAlreadyExists { week_id: 1 }));
}

#[test]
fn buy_ticket_is_rejected_once_the_week_is_stale_without_min_players() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    let err = buy_at_price(&mut deps, &later_env, "player2", BASE_PRICE + 7 * INCREMENT).unwrap_err();
    assert!(matches!(err, ContractError::WeekExpired {}));
}

#[test]
fn expire_week_fails_too_early_or_once_min_players_is_reached() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireWeek {}));

    let (mut deps2, env2) = setup_and_seed(5, 2, 7, 1);
    buy_at_price(&mut deps2, &env2, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps2, &env2, "player2", BASE_PRICE).unwrap();
    let mut later_env2 = env2.clone();
    later_env2.block.time = later_env2.block.time.plus_seconds(7 * 86400 + 1);
    let err = execute(deps2.as_mut(), later_env2, mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireWeek {}));
}

#[test]
fn expire_week_lets_buyers_reclaim_exactly_what_they_paid_at_their_own_days_price() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let mut day2_env = env.clone();
    day2_env.block.time = day2_env.block.time.plus_seconds(2 * 86400 + 10);
    buy_at_price(&mut deps, &day2_env, "player2", BASE_PRICE + 2 * INCREMENT).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "week_id" && a.value == "1"));

    let week1 = week_history(&deps, &later_env, 1);
    assert_eq!(week1.status, RoundStatus::Expired);
    assert_eq!(week1.ticket_sales_pool, Uint128::new(BASE_PRICE + BASE_PRICE + 2 * INCREMENT));

    let week2 = current_week(&deps, &later_env);
    assert_eq!(week2.week_id, 2);
    assert_eq!(week2.status, RoundStatus::Open);

    let reclaim1 = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { week_id: 1 }).unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) = &reclaim1.messages[0].msg {
        assert_eq!(amount, &coins(BASE_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    let reclaim2 = execute(deps.as_mut(), later_env.clone(), mock_info("player2", &[]), ExecuteMsg::ReclaimTicket { week_id: 1 }).unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { amount, .. }) = &reclaim2.messages[0].msg {
        assert_eq!(amount, &coins(BASE_PRICE + 2 * INCREMENT, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    assert_eq!(wallet_stats(&deps, &later_env, "player1").total_invested, Uint128::zero());
    assert_eq!(wallet_stats(&deps, &later_env, "player2").total_invested, Uint128::zero());
}

#[test]
fn expire_week_carries_wheel_contributions_forward_but_not_ticket_money() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("some-wheel-manager", &coins(4_000_000, TICKET_DENOM)),
        ExecuteMsg::ContributeToPool { source_wheel: "some-wheel-manager".to_string(), source_round_id: 1 },
    )
    .unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap();

    let week1 = week_history(&deps, &later_env, 1);
    assert_eq!(week1.wheel_contributions, Uint128::zero());
    assert_eq!(week1.ticket_sales_pool, Uint128::new(BASE_PRICE));

    let week2 = current_week(&deps, &later_env);
    assert_eq!(week2.wheel_contributions, Uint128::new(4_000_000));
}

#[test]
fn sweep_expired_prize_also_sweeps_an_abandoned_expired_week_pool() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(7 * 86400 + 1);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireWeek {}).unwrap();

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    let mut swept_env = later_env.clone();
    swept_env.block.time = swept_env.block.time.plus_seconds(91 * 86400);
    let res = execute(deps.as_mut(), swept_env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { week_id: 1 }).unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(BASE_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }

    let err = execute(deps.as_mut(), swept_env, mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn withdraw_ticket_before_min_players_refunds_the_exact_amount_paid() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let res = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::WithdrawTicket { week_id: 1 }).unwrap();
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

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::WithdrawTicket { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::zero());
}

#[test]
fn withdraw_ticket_is_rejected_once_min_players_is_reached() {
    let (mut deps, env) = setup_and_seed(5, 2, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::WithdrawTicket { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::WeekAlreadyLocked { .. }));
}

#[test]
fn withdraw_ticket_rejected_for_a_wallet_with_no_tickets_in_that_week() {
    let (mut deps, env) = setup_and_seed(5, 3, 7, 1);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();

    let err = execute(deps.as_mut(), env, mock_info("player2", &[]), ExecuteMsg::WithdrawTicket { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn wallet_stats_track_total_invested_across_weeks_and_total_redeemed_net_of_overpayment() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // auto-closes week 1

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::new(BASE_PRICE));
    assert_eq!(stats.total_redeemed, Uint128::zero());

    let draw_res = reveal(&mut deps, &env, 1, 1).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();

    buy_at_price(&mut deps, &env, &winner, BASE_PRICE).unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&winner, &coins(20_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { week_id: 1 },
    )
    .unwrap();

    let stats = wallet_stats(&deps, &env, &winner);
    assert_eq!(stats.total_invested, Uint128::new(BASE_PRICE * 2));
    assert_eq!(stats.total_redeemed, Uint128::new(17_000_000));
}

// --- v9: ContributeToPool must be infallible by week status ---

#[test]
fn contribute_to_pool_succeeds_regardless_of_week_status() {
    // The critical cross-contract invariant (Ronda 9, Opus finding 2.1):
    // wheel-manager sends this as a plain (non-SubMsg) message, so if it
    // could ever fail by state, it would brick wheel-manager's reveal.
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // week 1 closes

    // Week 1 is Closed - contribution still succeeds, queued via PENDING_CONTRIBUTIONS.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("some-wheel-manager", &coins(1_000_000, TICKET_DENOM)),
        ExecuteMsg::ContributeToPool { source_wheel: "some-wheel-manager".to_string(), source_round_id: 1 },
    )
    .unwrap();
    // Credited to week 2 (the currently Open week), not lost.
    assert_eq!(current_week(&deps, &env).wheel_contributions, Uint128::new(1_000_000));

    // Push week 1 into ExpiryPending and confirm ContributeToPool still works.
    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedWeek { week_id: 1 }).unwrap();
    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedWeek { week_id: 1 }).unwrap();
    assert_eq!(week_history(&deps, &finalize_env, 1).status, RoundStatus::ExpiryPending);

    execute(
        deps.as_mut(),
        finalize_env.clone(),
        mock_info("some-wheel-manager", &coins(500_000, TICKET_DENOM)),
        ExecuteMsg::ContributeToPool { source_wheel: "some-wheel-manager".to_string(), source_round_id: 1 },
    )
    .unwrap();
    assert_eq!(current_week(&deps, &finalize_env).wheel_contributions, Uint128::new(1_500_000));
}

// --- v9: 3-phase expiration ---

#[test]
fn full_3_phase_expiration_refunds_entrants_without_opening_a_new_week() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // week 1 closes, week 2 opens

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedWeek { week_id: 1 }).unwrap();

    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedWeek { week_id: 1 }).unwrap();
    assert_eq!(week_history(&deps, &finalize_env, 1).status, RoundStatus::ExpiryPending);

    let err = execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredWeek { week_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::ChallengeWindowOpen { .. }));

    let mut claim_env = finalize_env.clone();
    claim_env.block.height += EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS;
    execute(deps.as_mut(), claim_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredWeek { week_id: 1 }).unwrap();

    let week1 = week_history(&deps, &claim_env, 1);
    assert_eq!(week1.status, RoundStatus::Expired);
    assert!(week1.expired_at.is_some());

    // Week 2 was already open (opened atomically when week 1 closed) -
    // claiming week 1's expiration must not have opened a second week 2.
    let week2 = current_week(&deps, &claim_env);
    assert_eq!(week2.week_id, 2);
    assert_eq!(week2.status, RoundStatus::Open);

    let reclaim_res = execute(deps.as_mut(), claim_env.clone(), mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { week_id: 1 }).unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &reclaim_res.messages[0].msg {
        assert_eq!(to_address, "player1");
        assert_eq!(amount, &coins(BASE_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }
}

#[test]
fn request_and_finalize_expire_reject_a_week_that_is_not_the_queue_front() {
    // Ronda 10 audit fix regression test (Opus, WM-1/medium) - mirrors
    // wheel-manager's identical fix and test. Before this fix, neither step
    // checked front-of-queue (only ClaimExpiredWeek did), so a week stuck
    // behind an earlier undrawn one could run its whole 3-phase clock "in the
    // shadow" and become claimable the instant it reached the front.
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap(); // week 1 closes, week 2 opens
    buy_at_price(&mut deps, &env, "player3", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player4", BASE_PRICE).unwrap(); // week 2 closes, week 3 opens

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);

    // Week 2 is Closed and overdue too, but week 1 is still the front.
    let err = execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedWeek { week_id: 2 }).unwrap_err();
    assert!(matches!(err, ContractError::QueueMismatch { front: 1, week_id: 2 }));

    // Resolve week 1 normally, popping the queue - week 2 becomes the front.
    reveal(&mut deps, &overdue_env, 1, 1).unwrap();
    assert_eq!(week_history(&deps, &overdue_env, 1).status, RoundStatus::Drawn);

    let err = execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedWeek { week_id: 2 }).unwrap_err();
    assert!(matches!(err, ContractError::ExpireNotRequested { week_id: 2 }));

    // Now genuinely the front - the real 3-phase clock gets its own full
    // window from here, not zero.
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedWeek { week_id: 2 }).unwrap();
    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedWeek { week_id: 2 }).unwrap();
    assert_eq!(week_history(&deps, &finalize_env, 2).status, RoundStatus::ExpiryPending);

    let err = execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredWeek { week_id: 2 }).unwrap_err();
    assert!(matches!(err, ContractError::ChallengeWindowOpen { .. }));

    let mut claim_env = finalize_env.clone();
    claim_env.block.height += EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS;
    execute(deps.as_mut(), claim_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredWeek { week_id: 2 }).unwrap();
    assert_eq!(week_history(&deps, &claim_env, 2).status, RoundStatus::Expired);
}

#[test]
fn a_legitimate_reveal_still_rescues_a_week_already_in_expiry_pending() {
    let (mut deps, env) = setup_and_seed(2, 2, 7, 3);
    buy_at_price(&mut deps, &env, "player1", BASE_PRICE).unwrap();
    buy_at_price(&mut deps, &env, "player2", BASE_PRICE).unwrap();

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedWeek { week_id: 1 }).unwrap();
    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedWeek { week_id: 1 }).unwrap();

    let res = reveal(&mut deps, &finalize_env, 1, 1).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "reveal_draw"));
    assert_eq!(week_history(&deps, &finalize_env, 1).status, RoundStatus::Drawn);
}
