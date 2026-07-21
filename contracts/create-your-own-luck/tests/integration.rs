use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coin, coins, from_json, to_json_binary, CosmosMsg, Uint128, WasmMsg};
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
const USDC_DENOM: &str = "utestusdc"; // must match the hardcoded USDC_DENOM constant in contract.rs
const FEE_AMOUNT_USDC: u128 = 3_000_000; // "$3", charged directly - no oracle conversion anymore

type Deps = cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>;

fn setup(
    raffle_type: RaffleType,
    min_players: u32,
    max_players: u32,
    ticket_price: u128,
    podium_shares_bps: Vec<u32>,
) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
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

#[test]
fn podium_needs_min_players_covering_all_places() {
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
        podium_shares_bps: vec![5000, 3000, 2000], // 3 places, but min_players is only 2
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::PodiumNeedsMorePlayers { needed: 3 }));
}

#[test]
fn podium_shares_must_sum_to_10000() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 3,
        max_players: 5,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![5000, 3000, 1000], // sums to 9000, not 10000
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPodiumShares {}));
}

#[test]
fn podium_shares_reject_a_zero_percent_place() {
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
        podium_shares_bps: vec![10_000, 0], // sums to 10000, but a 0% "winner" is deceptive
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPodiumShares {}));
}

#[test]
fn podium_shares_reject_too_many_places() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    // 11 places (1 more than MAX_PODIUM_PLACES), summing to exactly 10000 so
    // the place-count cap is the only reason this is rejected.
    let mut too_many = vec![910u32; 10];
    too_many.push(900);
    let msg = InstantiateMsg {
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 11,
        max_players: 15,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: too_many,
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPodiumShares {}));
}

#[test]
fn podium_shares_rejected_for_non_podium_raffle() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::SingleWinner,
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
fn airdrop_rejects_max_players_over_the_last_fee_tier() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::Airdrop,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 1001,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::MaxPlayersExceedsAirdropFeeTiers {}));
}

#[test]
fn single_winner_and_podium_reject_max_players_over_100() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 101,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![],
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::MaxPlayersTooHighForRaffleType { max: 100 }));

    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        raffle_type: RaffleType::Podium,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 3,
        max_players: 101,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days: 90,
        prize_native_denom: Some(PRIZE_DENOM.to_string()),
        prize_cw20_address: None,
        podium_shares_bps: vec![5000, 3000, 2000],
    };
    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), msg).unwrap_err();
    assert!(matches!(err, ContractError::MaxPlayersTooHighForRaffleType { max: 100 }));
}

#[test]
fn single_winner_and_podium_always_charge_the_flat_fee_regardless_of_max_players() {
    // 100 is the max max_players allowed for these two raffle types (see
    // MAX_PLAYERS_SINGLE_WINNER_PODIUM).
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

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Closed);
    assert_eq!(status.unique_player_count, 2);
}

#[test]
fn allowlist_rejects_wallets_not_on_the_list() {
    let mut deps = mock_dependencies();
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
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    // 1 prize payout + 1 ticket-revenue-to-creator + 2 fee-split payouts (founder/treasury) = 4
    assert_eq!(res.messages.len(), 4);

    let config_bin = query(deps.as_ref(), later_env.clone(), QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(config_bin).unwrap();
    for (recipient, expected) in [
        (&config.founder_fee_address, 1_500_000u128),
        (&config.treasury_address, 1_500_000u128),
    ] {
        let sent = res.messages.iter().find_map(|m| match &m.msg {
            CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) if to_address == recipient.as_str() => {
                Some(amount.clone())
            }
            _ => None,
        });
        assert_eq!(sent, Some(coins(expected, USDC_DENOM)), "expected {expected} to {recipient}");
    }

    let winners_bin = query(deps.as_ref(), later_env, QueryMsg::GetWinners {}).unwrap();
    let winners: WinnersResponse = from_json(winners_bin).unwrap();
    assert_eq!(winners.winners.len(), 1);
    assert_eq!(winners.prize_shares, vec![Uint128::new(1000)]);
}

#[test]
fn only_creator_can_draw_winner() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::DrawWinner {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    execute(deps.as_mut(), later_env, mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
}

#[test]
fn non_creator_can_draw_winner_after_the_long_fallback_deadline() {
    // default unclaimed_deadline_days from `setup` is 90. Time is advanced
    // between opening (deposit_prize) and closing (auto-close on the 2nd
    // ticket) so opened_at != closed_at - otherwise this test couldn't tell
    // a correct closed_at-anchored deadline apart from a regression that
    // accidentally anchored it to opened_at instead.
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();

    let mut close_env = env.clone();
    close_env.block.time = close_env.block.time.plus_seconds(20 * 86400);
    buy_ticket(&mut deps, &close_env, "player2", 100).unwrap(); // auto-closes; closed_at = opened_at + 20 days

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
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap();

    // Well below max_players (10) and no time has elapsed - only the
    // creator's early-close path can succeed here.
    execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Closed);
}

#[test]
fn non_creator_cannot_close_round_early() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));
}

#[test]
fn creator_cannot_close_round_below_min_players() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 10, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();

    let err = execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));
}

#[test]
fn draw_winner_past_the_window_rearms_instead_of_drawing() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 2, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();
    buy_ticket(&mut deps, &env, "player2", 100).unwrap(); // auto-closes, draw_after_height = height + 5, window width 10

    let mut too_late_env = env.clone();
    too_late_env.block.height += 15; // first height past the ceiling
    let res = execute(deps.as_mut(), too_late_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    assert_eq!(res.attributes.iter().find(|a| a.key == "action").unwrap().value, "rearm_draw_window");
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
fn podium_picks_three_distinct_winners_with_creator_chosen_50_30_20_split() {
    let (mut deps, env) = setup(RaffleType::Podium, 3, 3, 0, vec![5000, 3000, 2000]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    buy_ticket(&mut deps, &env, "player3", 0).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    execute(deps.as_mut(), later_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    let winners_bin = query(deps.as_ref(), later_env, QueryMsg::GetWinners {}).unwrap();
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
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    execute(deps.as_mut(), later_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    let winners_bin = query(deps.as_ref(), later_env, QueryMsg::GetWinners {}).unwrap();
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
    buy_ticket(&mut deps, &env, "player4", 0).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    execute(deps.as_mut(), later_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

    let winners_bin = query(deps.as_ref(), later_env, QueryMsg::GetWinners {}).unwrap();
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
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();

    let mut later_env = env.clone();
    later_env.block.height += 5;
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();
    // no per-winner prize payout for Airdrop itself (that's pulled later via
    // ClaimAirdropShare); the 2 messages here are the founder/treasury fee split.
    assert_eq!(res.messages.len(), 2);

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
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 3, 100, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();
    buy_ticket(&mut deps, &env, "player1", 100).unwrap();

    let res = execute(deps.as_mut(), env.clone(), mock_info("creator", &[]), ExecuteMsg::CancelRaffle {}).unwrap();
    // prize refund + fee refund + player1's ticket refund = 3
    assert_eq!(res.messages.len(), 3);

    let status = raffle_status(&deps, &env);
    assert_eq!(status.status, RaffleStatus::Cancelled);
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

fn instantiate_with_prize(
    prize_native_denom: Option<&str>,
    prize_cw20_address: Option<&str>,
) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
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
    buy_ticket(&mut deps, &env, "player2", 0).unwrap();
    let mut later_env = env.clone();
    later_env.block.height += 5;
    let draw_res = execute(deps.as_mut(), later_env, mock_info("creator", &[]), ExecuteMsg::DrawWinner {}).unwrap();

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
        podium_shares_bps: vec![],
    };

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), base_msg(0, 5)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));

    let err = instantiate(deps.as_mut(), env, mock_info("creator", &[]), base_msg(5, 2)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidPlayerBounds {}));
}

#[test]
fn instantiate_rejects_unclaimed_deadline_days_out_of_range() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let base_msg = |unclaimed_deadline_days: u64| InstantiateMsg {
        raffle_type: RaffleType::SingleWinner,
        ticket_price: Uint128::zero(),
        ticket_denom: TICKET_DENOM.to_string(),
        allowed_entrants: None,
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 3600,
        draw_delay_blocks: 5,
        draw_window_blocks: 10,
        unclaimed_deadline_days,
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
fn ticket_cap_per_wallet_is_half_of_max_players_minimum_one() {
    let (mut deps, env) = setup(RaffleType::SingleWinner, 2, 4, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, FEE_AMOUNT_USDC).unwrap();

    // max_players=4 -> cap = max(1, 4/2) = 2.
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let err = buy_ticket(&mut deps, &env, "player1", 0).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));
}

#[test]
fn airdrop_caps_at_one_ticket_per_wallet_regardless_of_max_players() {
    let (mut deps, env) = setup(RaffleType::Airdrop, 2, 1000, 0, vec![]);
    deposit_prize(&mut deps, &env, 1000, 18_000_000).unwrap();

    buy_ticket(&mut deps, &env, "player1", 0).unwrap();
    let err = buy_ticket(&mut deps, &env, "player1", 0).unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 1 }));
}
