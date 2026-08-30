use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coin, coins, from_json, CosmosMsg, HexBinary, Uint128, WasmMsg};
use sha2::{Digest, Sha256};

use wheel_manager::contract::{execute, instantiate, query};
use wheel_manager::execute::{
    open_new_round, EXPIRE_CHALLENGE_BLOCKS, EXPIRE_FINALIZE_DELAY_BLOCKS, REVEAL_PRIORITY_MARGIN_BLOCKS,
};
use wheel_manager::msg::{
    ConfigResponse, EntrantsResponse, ExecuteMsg, InstantiateMsg, MyWinningsResponse, QueryMsg,
    RoundResponse, WalletStatsResponse,
};
use wheel_manager::state::RoundStatus;
use wheel_manager::ContractError;

const TICKET_DENOM: &str = "uusdc";
const REDEMPTION_DENOM: &str = "uustc";
const TICKET_PRICE: u128 = 1_000_000;
const MAX_REVEAL_AGE_SECONDS: u64 = 3600;

type Deps = cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
>;

/// A deterministic 32-byte preimage for round/test index `n`, and its commit
/// (`sha256(preimage)`) - lets tests push commits in a known order and later
/// reveal with the exact preimage that satisfies whichever round consumed it.
fn preimage_for(n: u8) -> HexBinary {
    HexBinary::from([n; 32])
}
fn commit_for(preimage: &HexBinary) -> HexBinary {
    HexBinary::from(Sha256::digest(preimage.as_slice()).to_vec())
}

fn setup(max_players: u32, min_players: u32) -> (Deps, cosmwasm_std::Env) {
    setup_with_reveal_age(max_players, min_players, MAX_REVEAL_AGE_SECONDS)
}

fn setup_with_reveal_age(max_players: u32, min_players: u32, max_reveal_age_seconds: u64) -> (Deps, cosmwasm_std::Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let msg = InstantiateMsg {
        ticket_price: Uint128::new(TICKET_PRICE),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players,
        max_players,
        round_timeout_seconds: 3600,
        unclaimed_deadline_days: 90,
        max_round_age_seconds: 172_800, // 48h
        max_reveal_age_seconds,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        weekly_round_address: "weeklyround".to_string(),
        commit_pusher: "committer".to_string(),
    };
    let info = mock_info("admin", &[]);
    instantiate(deps.as_mut(), env.clone(), info, msg).unwrap();
    (deps, env)
}

/// Instantiates, pushes `count` commits (indices 1..=count), and assigns the
/// first one to round 1 - the normal bot lifecycle for a freshly deployed
/// contract. Round 2, 3, ... auto-consume the remaining pushed commits as
/// they open, in order.
fn setup_and_seed(max_players: u32, min_players: u32, count: u8) -> (Deps, cosmwasm_std::Env) {
    let (mut deps, env) = setup(max_players, min_players);
    let commits: Vec<HexBinary> = (1..=count).map(|n| commit_for(&preimage_for(n))).collect();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("committer", &[]),
        ExecuteMsg::PushCommits { commits },
    )
    .unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap();
    (deps, env)
}

fn buy_ticket(deps: &mut Deps, env: &cosmwasm_std::Env, sender: &str) -> Result<cosmwasm_std::Response, ContractError> {
    let info = mock_info(sender, &coins(TICKET_PRICE, TICKET_DENOM));
    execute(deps.as_mut(), env.clone(), info, ExecuteMsg::BuyTicket {})
}

fn current_round(deps: &Deps, env: &cosmwasm_std::Env) -> RoundResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetCurrentRound {}).unwrap();
    from_json(bin).unwrap()
}

fn round_history(deps: &Deps, env: &cosmwasm_std::Env, round_id: u64) -> RoundResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetRoundHistory { round_id }).unwrap();
    from_json(bin).unwrap()
}

fn wallet_stats(deps: &Deps, env: &cosmwasm_std::Env, wallet: &str) -> WalletStatsResponse {
    let bin = query(deps.as_ref(), env.clone(), QueryMsg::GetWalletStats { wallet: wallet.to_string() }).unwrap();
    from_json(bin).unwrap()
}

/// Reveals round `round_id` using the preimage indexed `n` (see
/// `preimage_for`/`setup_and_seed` - round `n` consumed commit `n` in the
/// straight-line case with no expirations/backfills in between).
fn reveal(deps: &mut Deps, env: &cosmwasm_std::Env, round_id: u64, n: u8) -> Result<cosmwasm_std::Response, ContractError> {
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("anyone", &[]),
        ExecuteMsg::RevealDraw { round_id, preimage: preimage_for(n) },
    )
}

// Funds check runs before any state is loaded (REVEAL_QUEUE, round status),
// so these fire on a freshly-opened round regardless - round-review fix
// (CodeRabbit, 2026-08-30): RevealDraw and the 3-phase rescue actions never
// checked attached funds at all, unlike every other message in this contract.
#[test]
fn reveal_draw_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::RevealDraw { round_id: 1, preimage: preimage_for(1) },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn request_expire_closed_round_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::RequestExpireClosedRound { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn finalize_expire_closed_round_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::FinalizeExpireClosedRound { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn claim_expired_round_rejects_unexpected_funds() {
    let (mut deps, env) = setup(3, 2);
    let err = execute(
        deps.as_mut(),
        env,
        mock_info("anyone", &coins(1, "some_other_denom")),
        ExecuteMsg::ClaimExpiredRound { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedFundsAttached { .. }));
}

#[test]
fn wrong_ticket_amount_is_rejected() {
    let (mut deps, env) = setup_and_seed(3, 2, 3);
    let info = mock_info("player1", &coins(TICKET_PRICE - 1, TICKET_DENOM));
    let err = execute(deps.as_mut(), env, info, ExecuteMsg::BuyTicket {}).unwrap_err();
    assert!(matches!(err, ContractError::WrongTicketPayment { .. }));
}

#[test]
fn multiple_tickets_from_the_same_wallet_count_as_one_player() {
    // max_players=6 -> ticket cap per wallet is max(1, 6/2) = 3, just enough
    // for this test to buy 3 tickets from the same wallet.
    let (mut deps, env) = setup_and_seed(6, 2, 3);
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
    let (mut deps, env) = setup_and_seed(4, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();
    let err = buy_ticket(&mut deps, &env, "player1").unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 2 }));

    // A different wallet is unaffected by player1's cap.
    buy_ticket(&mut deps, &env, "player2").unwrap();

    // max_players=2 -> cap = max(1, 2/2) = 1 (the floor never goes to zero).
    let (mut deps2, env2) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps2, &env2, "player1").unwrap();
    let err = buy_ticket(&mut deps2, &env2, "player1").unwrap_err();
    assert!(matches!(err, ContractError::TicketCapExceeded { max_per_wallet: 1 }));
}

#[test]
fn reaching_max_unique_players_auto_closes_without_drawing() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    let res1 = buy_ticket(&mut deps, &env, "player1").unwrap();
    assert!(res1.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "false"));

    let res2 = buy_ticket(&mut deps, &env, "player2").unwrap();
    assert!(res2.attributes.iter().any(|a| a.key == "auto_closed" && a.value == "true"));
    // v9: the sold-out branch never draws in the same tx - no winner/payout
    // messages here, just the close.
    assert!(res2.messages.is_empty());

    let round1 = round_history(&deps, &env, 1);
    assert_eq!(round1.status, RoundStatus::Closed);
    assert!(round1.closed_at_height.is_some());
    assert_eq!(round1.winner, None);

    // Round 2 opened immediately - the game isn't stuck waiting on round 1's
    // reveal (this is the point of decoupling close from reveal).
    let round2 = current_round(&deps, &env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);

    // Round 1 is closed now, tickets go toward round 2.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player3", &coins(TICKET_PRICE, TICKET_DENOM)),
        ExecuteMsg::BuyTicket {},
    );
    assert!(err.is_ok()); // buys into round 2, which is open
    assert_eq!(current_round(&deps, &env).ticket_count, 1);
}

#[test]
fn close_round_before_max_or_timeout_fails() {
    let (mut deps, env) = setup_and_seed(3, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotCloseRound {}));
}

#[test]
fn close_round_after_timeout_with_min_players_succeeds() {
    let (mut deps, env) = setup_and_seed(5, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(3601);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap();

    let round1 = round_history(&deps, &later_env, 1);
    assert_eq!(round1.status, RoundStatus::Closed);
    // Round 2 already open - close always opens its successor atomically.
    let round2 = current_round(&deps, &later_env);
    assert_eq!(round2.status, RoundStatus::Open);
}

#[test]
fn buying_a_ticket_after_min_players_resets_the_close_deadline() {
    let (mut deps, env) = setup_and_seed(5, 2, 3);
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
    let round1 = round_history(&deps, &later_env, 1);
    assert_eq!(round1.status, RoundStatus::Closed);
}

#[test]
fn reveal_draw_rejects_wrong_preimage() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // auto-closes round 1

    let err = reveal(&mut deps, &env, 1, 2 /* wrong preimage, round 1 used commit 1 */).unwrap_err();
    assert!(matches!(err, ContractError::BadPreimage {}));
}

#[test]
fn reveal_draw_rejects_a_round_id_that_is_not_the_queue_front() {
    // The exact scenario both Ronda 9 auditors flagged independently:
    // round A closes, round B closes before A is revealed, and revealing B
    // out of order must not desync the queue.
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // round 1 closes, round 2 opens
    buy_ticket(&mut deps, &env, "player3").unwrap();
    buy_ticket(&mut deps, &env, "player4").unwrap(); // round 2 closes, round 3 opens

    // Trying to reveal round 2 first (queue front is round 1) is rejected -
    // and does not touch storage: the queue and both rounds are unaffected.
    let err = reveal(&mut deps, &env, 2, 2).unwrap_err();
    assert!(matches!(err, ContractError::QueueMismatch { front: 1, round_id: 2 }));
    assert_eq!(round_history(&deps, &env, 1).status, RoundStatus::Closed);
    assert_eq!(round_history(&deps, &env, 2).status, RoundStatus::Closed);

    // Revealing round 1 (the real front) succeeds.
    let res1 = reveal(&mut deps, &env, 1, 1).unwrap();
    assert!(res1.attributes.iter().any(|a| a.key == "action" && a.value == "reveal_draw"));
    assert_eq!(round_history(&deps, &env, 1).status, RoundStatus::Drawn);

    // Now that round 1 is gone from the queue, round 2 is the front and
    // reveals normally.
    let res2 = reveal(&mut deps, &env, 2, 2).unwrap();
    assert!(res2.attributes.iter().any(|a| a.key == "action" && a.value == "reveal_draw"));
    assert_eq!(round_history(&deps, &env, 2).status, RoundStatus::Drawn);
}

#[test]
fn reveal_draw_succeeds_and_splits_correctly() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // auto-closes round 1, opens round 2

    let res = reveal(&mut deps, &env, 1, 1).unwrap();

    let winner_attr = res.attributes.iter().find(|a| a.key == "winner").unwrap();
    assert!(winner_attr.value == "player1" || winner_attr.value == "player2");

    let prize_attr = res.attributes.iter().find(|a| a.key == "prize").unwrap();
    // pool = 2_000_000 -> 60% prize = 1_200_000
    assert_eq!(prize_attr.value, "1200000");

    // treasury (12% + dust) + admin (3%) BankMsg::Send, + weekly (20%) WasmMsg::Execute
    assert_eq!(res.messages.len(), 3);
    let has_weekly_wasm_call = res.messages.iter().any(|m| matches!(&m.msg, CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, .. }) if contract_addr == "weeklyround"));
    assert!(has_weekly_wasm_call);

    let round1 = round_history(&deps, &env, 1);
    assert_eq!(round1.status, RoundStatus::Drawn);
    assert_eq!(round1.prize_remaining, Uint128::new(1_200_000));
    assert_eq!(round1.revealed_preimage, Some(preimage_for(1)));

    let round2 = current_round(&deps, &env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);
    // 5% of 2_000_000 = 100_000 carried into round 2's pool
    assert_eq!(round2.pool, Uint128::new(100_000));
}

#[test]
fn only_the_winner_can_redeem_and_overpay_is_refunded() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();
    let draw_res = reveal(&mut deps, &env, 1, 1).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();
    let loser = if winner == "player1" { "player2" } else { "player1" };

    // Non-winner cannot redeem.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(loser, &coins(1_200_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotWinner { .. }));

    // Winner overpays (sends more USTC than the remaining prize) -> gets change back.
    let redeem_res = execute(
        deps.as_mut(),
        env.clone(),
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
        env.clone(),
        mock_info(&winner, &coins(1, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NothingToRedeem { .. }));

    let winnings_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyWinnings { wallet: winner.clone() }).unwrap();
    let winnings: MyWinningsResponse = from_json(winnings_bin).unwrap();
    assert!(winnings.winnings.is_empty());
}

#[test]
fn partial_redeem_keeps_the_wallet_in_the_winnings_index() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();
    let draw_res = reveal(&mut deps, &env, 1, 1).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&winner, &coins(500_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap();

    let winnings_bin = query(deps.as_ref(), env.clone(), QueryMsg::GetMyWinnings { wallet: winner.clone() }).unwrap();
    let winnings: MyWinningsResponse = from_json(winnings_bin).unwrap();
    assert_eq!(winnings.winnings.len(), 1);
    assert_eq!(winnings.winnings[0].prize_remaining, Uint128::new(700_000));
}

#[test]
fn admin_only_actions_reject_non_admin() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    let err = execute(deps.as_mut(), env.clone(), mock_info("not-admin", &[]), ExecuteMsg::SweepUstc {}).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    let err = execute(
        deps.as_mut(),
        env,
        mock_info("not-admin", &[]),
        ExecuteMsg::PushCommits { commits: vec![commit_for(&preimage_for(9))] },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

#[test]
fn commit_pusher_and_admin_roles_cannot_do_each_others_job() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    // admin (the instantiate sender) is not commit_pusher ("committer") -
    // must not be able to push commits even though it's the highest-
    // privilege wallet in every other respect.
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
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();
    reveal(&mut deps, &env, 1, 1).unwrap();

    // Too early - default unclaimed_deadline_days is 90.
    let err = execute(deps.as_mut(), env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    // 90+ days later, ANYONE (not just admin) can trigger the sweep.
    let mut expired_env = env.clone();
    expired_env.block.time = expired_env.block.time.plus_seconds(91 * 86400);
    let res = execute(deps.as_mut(), expired_env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { round_id: 1 }).unwrap();
    assert_eq!(res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(1_200_000, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }

    let round1 = round_history(&deps, &expired_env, 1);
    assert_eq!(round1.prize_remaining, Uint128::zero());

    let err = execute(deps.as_mut(), expired_env, mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NothingToRedeem { .. }));
}

#[test]
fn sweep_ustc_moves_the_contracts_redemption_denom_balance_to_treasury() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    deps.querier.update_balance(env.contract.address.clone(), coins(42, REDEMPTION_DENOM));

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
    let (deps, env) = setup_and_seed(7, 3, 1);
    let bin = query(deps.as_ref(), env, QueryMsg::GetConfig {}).unwrap();
    let config: ConfigResponse = from_json(bin).unwrap();
    assert_eq!(config.max_players, 7);
    assert_eq!(config.min_players, 3);
    assert_eq!(config.ticket_price, Uint128::new(TICKET_PRICE));
    assert_eq!(config.ticket_denom, TICKET_DENOM);
    assert_eq!(config.redemption_denom, REDEMPTION_DENOM);
    assert_eq!(config.max_reveal_age_seconds, MAX_REVEAL_AGE_SECONDS);
}

#[test]
fn get_round_entrants_returns_one_entry_per_ticket_including_duplicates() {
    let (mut deps, env) = setup_and_seed(6, 2, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let round = current_round(&deps, &env);
    let bin = query(deps.as_ref(), env, QueryMsg::GetRoundEntrants { round_id: round.round_id }).unwrap();
    let resp: EntrantsResponse = from_json(bin).unwrap();
    assert_eq!(resp.entrants.len(), 3);
    assert_eq!(resp.entrants.iter().filter(|a| a.as_str() == "player1").count(), 2);
    assert_eq!(resp.entrants.iter().filter(|a| a.as_str() == "player2").count(), 1);
}

#[test]
fn buy_ticket_with_extra_unrelated_denom_attached_is_still_rejected_if_price_wrong() {
    let (mut deps, env) = setup_and_seed(3, 2, 1);
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
        unclaimed_deadline_days: 90,
        max_round_age_seconds: 172_800,
        max_reveal_age_seconds: MAX_REVEAL_AGE_SECONDS,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        weekly_round_address: "weeklyround".to_string(),
        commit_pusher: "committer".to_string(),
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
fn instantiate_rejects_out_of_bounds_max_reveal_age_seconds() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let base_msg = |max_reveal_age_seconds: u64| InstantiateMsg {
        ticket_price: Uint128::new(TICKET_PRICE),
        ticket_denom: TICKET_DENOM.to_string(),
        redemption_denom: REDEMPTION_DENOM.to_string(),
        min_players: 2,
        max_players: 5,
        round_timeout_seconds: 3600,
        unclaimed_deadline_days: 90,
        max_round_age_seconds: 172_800,
        max_reveal_age_seconds,
        treasury_address: "treasury".to_string(),
        admin_fee_address: "adminfee".to_string(),
        weekly_round_address: "weeklyround".to_string(),
        commit_pusher: "committer".to_string(),
    };

    // Zero (or anything below the floor) would make RequestExpireClosedRound
    // callable immediately after closing - reopening the cheap version of
    // the mempool front-run risk in normal operation, not just after a real
    // outage.
    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(0)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidMaxRevealAgeSeconds { .. }));

    let err = instantiate(deps.as_mut(), env.clone(), mock_info("admin", &[]), base_msg(u64::MAX)).unwrap_err();
    assert!(matches!(err, ContractError::InvalidMaxRevealAgeSeconds { .. }));

    // In bounds succeeds.
    instantiate(deps.as_mut(), env, mock_info("admin", &[]), base_msg(MAX_REVEAL_AGE_SECONDS)).unwrap();
}

#[test]
fn buy_ticket_is_rejected_before_a_commit_is_assigned() {
    // No PushCommits/AssignCommit at all - round 1 opens with commit_used = None.
    let (mut deps, env) = setup(5, 3);
    let err = buy_ticket(&mut deps, &env, "player1").unwrap_err();
    assert!(matches!(err, ContractError::RoundNotSeeded {}));

    // Once seeded, the exact same call succeeds.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("committer", &[]),
        ExecuteMsg::PushCommits { commits: vec![commit_for(&preimage_for(1))] },
    )
    .unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap();
}

#[test]
fn push_commits_rejects_duplicates_within_a_batch_and_across_batches() {
    let (mut deps, env) = setup(5, 3);
    let c1 = commit_for(&preimage_for(1));

    // Duplicate within the same batch.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("committer", &[]),
        ExecuteMsg::PushCommits { commits: vec![c1.clone(), c1.clone()] },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::CommitAlreadyUsed {}));

    // First push succeeds.
    execute(deps.as_mut(), env.clone(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1.clone()] }).unwrap();

    // Pushing the same commit again in a later batch is rejected, even
    // though it hasn't been consumed by any round yet - reusing a commit
    // would let revealing one round leak the secret for another still-
    // pending one.
    let err = execute(deps.as_mut(), env, mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1] }).unwrap_err();
    assert!(matches!(err, ContractError::CommitAlreadyUsed {}));
}

#[test]
fn push_commits_rejects_wrong_length_and_empty_or_oversized_batches() {
    let (mut deps, env) = setup(5, 3);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("committer", &[]),
        ExecuteMsg::PushCommits { commits: vec![HexBinary::from([1u8; 31])] },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidCommitLength {}));

    let err = execute(deps.as_mut(), env.clone(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![] }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidCommitBatch { .. }));

    let too_many: Vec<HexBinary> = (0..51u16).map(|n| commit_for(&HexBinary::from([n as u8, (n >> 8) as u8].repeat(16)))).collect();
    let err = execute(deps.as_mut(), env, mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: too_many }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidCommitBatch { .. }));
}

#[test]
fn assign_commit_only_works_while_open_with_no_entrants_and_no_commit_yet() {
    let (mut deps, env) = setup(5, 3);
    // Nothing to assign yet.
    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap_err();
    assert!(matches!(err, ContractError::NoCommitsAvailable {}));

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info("committer", &[]),
        ExecuteMsg::PushCommits { commits: vec![commit_for(&preimage_for(1)), commit_for(&preimage_for(2))] },
    )
    .unwrap();
    execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap();

    // Already assigned - a second call is rejected even though the queue
    // still has a spare commit.
    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap_err();
    assert!(matches!(err, ContractError::CommitAlreadyAssigned {}));

    // Once an entrant has bought in, the entrants.is_empty() guard (checked
    // ahead of the commit-already-assigned check) is what now rejects it.
    buy_ticket(&mut deps, &env, "player1").unwrap();
    let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::AssignCommit {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotAssignCommit {}));
}

#[test]
fn open_new_round_rejects_a_round_id_that_already_exists() {
    // Direct unit-level check of the defense-in-depth guard - not reachable
    // through the public execute API in the happy path, but confirms the
    // function itself refuses to silently overwrite a live round.
    let (mut deps, env) = setup(5, 3);
    let err = open_new_round(deps.as_mut().storage, &env, 1).unwrap_err();
    assert!(matches!(err, ContractError::RoundAlreadyExists { round_id: 1 }));
}

#[test]
fn buy_ticket_is_rejected_once_the_round_is_stale_without_min_players() {
    let (mut deps, env) = setup_and_seed(5, 3, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(172_801); // > 48h
    let err = buy_ticket(&mut deps, &later_env, "player2").unwrap_err();
    assert!(matches!(err, ContractError::RoundExpired {}));
}

#[test]
fn expire_round_fails_too_early_or_once_min_players_is_reached() {
    let (mut deps, env) = setup_and_seed(5, 3, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    // Too early - max_round_age_seconds (48h) hasn't elapsed yet.
    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireRound {}));

    // A different round that did reach min_players can't be expired even
    // after the same amount of time - it should be closed/revealed normally.
    let (mut deps2, env2) = setup_and_seed(5, 2, 1);
    buy_ticket(&mut deps2, &env2, "player1").unwrap();
    buy_ticket(&mut deps2, &env2, "player2").unwrap();
    let mut later_env2 = env2.clone();
    later_env2.block.time = later_env2.block.time.plus_seconds(172_801);
    let err = execute(deps2.as_mut(), later_env2, mock_info("anyone", &[]), ExecuteMsg::ExpireRound {}).unwrap_err();
    assert!(matches!(err, ContractError::CannotExpireRound {}));
}

#[test]
fn expire_round_lets_buyers_reclaim_their_own_tickets_and_opens_a_new_round() {
    let (mut deps, env) = setup_and_seed(5, 3, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(172_801);
    let res = execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireRound {}).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "round_id" && a.value == "1"));

    let round1 = round_history(&deps, &later_env, 1);
    assert_eq!(round1.status, RoundStatus::Expired);
    assert_eq!(round1.pool, Uint128::new(TICKET_PRICE));

    let round2 = current_round(&deps, &later_env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("player2", &[]), ExecuteMsg::ReclaimTicket { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    let reclaim_res = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { round_id: 1 }).unwrap();
    assert_eq!(reclaim_res.messages.len(), 1);
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &reclaim_res.messages[0].msg {
        assert_eq!(to_address, "player1");
        assert_eq!(amount, &coins(TICKET_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    let stats = wallet_stats(&deps, &later_env, "player1");
    assert_eq!(stats.total_invested, Uint128::zero());
}

#[test]
fn hard_cap_forces_close_even_while_the_rolling_deadline_keeps_getting_reset() {
    let (mut deps, env) = setup_and_seed(10, 2, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // min_players reached, rolling deadline starts

    let mut env2 = env.clone();
    env2.block.time = env2.block.time.plus_seconds(200_000);
    buy_ticket(&mut deps, &env2, "player3").unwrap();

    execute(deps.as_mut(), env2.clone(), mock_info("anyone", &[]), ExecuteMsg::CloseRound {}).unwrap();
    let round1 = round_history(&deps, &env2, 1);
    assert_eq!(round1.status, RoundStatus::Closed);
}

#[test]
fn sweep_expired_prize_also_sweeps_an_abandoned_expired_round_pool() {
    let (mut deps, env) = setup_and_seed(5, 3, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let mut later_env = env.clone();
    later_env.block.time = later_env.block.time.plus_seconds(172_801);
    execute(deps.as_mut(), later_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ExpireRound {}).unwrap();

    let err = execute(deps.as_mut(), later_env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::UnclaimedDeadlineNotReached { .. }));

    let mut swept_env = later_env.clone();
    swept_env.block.time = swept_env.block.time.plus_seconds(91 * 86400);
    let res = execute(deps.as_mut(), swept_env.clone(), mock_info("randomcaller", &[]), ExecuteMsg::SweepExpiredPrize { round_id: 1 }).unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &res.messages[0].msg {
        assert_eq!(to_address, "treasury");
        assert_eq!(amount, &coins(TICKET_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send to the treasury");
    }

    let err = execute(deps.as_mut(), swept_env, mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn withdraw_ticket_before_min_players_refunds_exact_amount_and_unlocks_the_wallet() {
    let (mut deps, env) = setup_and_seed(5, 3, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player1").unwrap(); // 2 tickets, still below min_players=3

    let res = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::WithdrawTicket { round_id: 1 }).unwrap();
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

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::WithdrawTicket { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::zero());
}

#[test]
fn withdraw_ticket_is_rejected_once_min_players_is_reached() {
    let (mut deps, env) = setup_and_seed(5, 2, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // min_players reached, deadline live

    let err = execute(deps.as_mut(), env.clone(), mock_info("player1", &[]), ExecuteMsg::WithdrawTicket { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::RoundAlreadyLocked { .. }));
}

#[test]
fn withdraw_ticket_rejected_for_a_wallet_with_no_tickets_in_that_round() {
    let (mut deps, env) = setup_and_seed(5, 3, 1);
    buy_ticket(&mut deps, &env, "player1").unwrap();

    let err = execute(deps.as_mut(), env, mock_info("player2", &[]), ExecuteMsg::WithdrawTicket { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NotAnEntrant { .. }));
}

#[test]
fn wallet_stats_track_total_invested_across_rounds_and_total_redeemed_net_of_overpayment() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // auto-closes round 1

    let stats = wallet_stats(&deps, &env, "player1");
    assert_eq!(stats.total_invested, Uint128::new(TICKET_PRICE));
    assert_eq!(stats.total_redeemed, Uint128::zero());

    let draw_res = reveal(&mut deps, &env, 1, 1).unwrap();
    let winner = draw_res.attributes.iter().find(|a| a.key == "winner").unwrap().value.clone();

    // Winner buys into round 2 as well - total_invested should accumulate
    // across rounds, not reset per round.
    buy_ticket(&mut deps, &env, &winner).unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&winner, &coins(2_000_000, REDEMPTION_DENOM)),
        ExecuteMsg::Redeem { round_id: 1 },
    )
    .unwrap();

    let stats = wallet_stats(&deps, &env, &winner);
    assert_eq!(stats.total_invested, Uint128::new(TICKET_PRICE * 2));
    assert_eq!(stats.total_redeemed, Uint128::new(1_200_000));
}

// --- v9: 3-phase expiration of a Closed round that never gets revealed ---

#[test]
fn request_expire_closed_round_fails_before_max_reveal_age_seconds_elapses() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // round 1 closes

    let err = execute(deps.as_mut(), env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::RevealNotYetOverdue { .. }));

    let mut almost_env = env.clone();
    almost_env.block.time = almost_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS - 1);
    let err = execute(deps.as_mut(), almost_env, mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::RevealNotYetOverdue { .. }));
}

#[test]
fn full_3_phase_expiration_refunds_entrants_without_opening_a_new_round() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // round 1 closes, round 2 opens

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 1 }).unwrap();

    // Finalize too early (before EXPIRE_FINALIZE_DELAY_BLOCKS) fails.
    let err = execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedRound { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::FinalizeDelayNotElapsed { .. }));

    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedRound { round_id: 1 }).unwrap();
    assert_eq!(round_history(&deps, &finalize_env, 1).status, RoundStatus::ExpiryPending);

    // Claiming too early (before EXPIRE_CHALLENGE_BLOCKS) fails.
    let err = execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::ChallengeWindowOpen { .. }));

    let mut claim_env = finalize_env.clone();
    claim_env.block.height += EXPIRE_CHALLENGE_BLOCKS;
    let err = execute(deps.as_mut(), claim_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::ChallengeWindowOpen { .. }), "REVEAL_PRIORITY_MARGIN_BLOCKS hasn't elapsed yet");

    claim_env.block.height += REVEAL_PRIORITY_MARGIN_BLOCKS;
    let res = execute(deps.as_mut(), claim_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 1 }).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "claim_expired_round"));

    let round1 = round_history(&deps, &claim_env, 1);
    assert_eq!(round1.status, RoundStatus::Expired);
    assert!(round1.expired_at.is_some());

    // Round 2 was already open (opened atomically when round 1 closed) -
    // claiming round 1's expiration must NOT have opened a second round 2 or
    // touched it in any way.
    let round2 = current_round(&deps, &claim_env);
    assert_eq!(round2.round_id, 2);
    assert_eq!(round2.status, RoundStatus::Open);

    // Round 1's queue entry is gone entirely (nothing else ever closed in
    // this test), so the front-of-queue check itself is what now rejects a
    // reveal attempt on it - checked before status, since there's nothing to
    // reveal at all.
    let err = reveal(&mut deps, &claim_env, 1, 1).unwrap_err();
    assert!(matches!(err, ContractError::NothingToReveal {}));

    // Each entrant can reclaim their own ticket.
    let reclaim_res = execute(deps.as_mut(), claim_env.clone(), mock_info("player1", &[]), ExecuteMsg::ReclaimTicket { round_id: 1 }).unwrap();
    if let CosmosMsg::Bank(cosmwasm_std::BankMsg::Send { to_address, amount }) = &reclaim_res.messages[0].msg {
        assert_eq!(to_address, "player1");
        assert_eq!(amount, &coins(TICKET_PRICE, TICKET_DENOM));
    } else {
        panic!("expected a BankMsg::Send");
    }
}

#[test]
fn request_and_finalize_expire_reject_a_round_that_is_not_the_queue_front() {
    // Ronda 10 audit fix regression test (Opus, WM-1/medium): before this fix,
    // RequestExpireClosedRound/FinalizeExpireClosedRound had no front-of-queue
    // check (only ClaimExpiredRound did) - a round stuck behind an earlier
    // undrawn one could run its whole 3-phase clock "in the shadow" and become
    // claimable the instant it reached the front, with zero real
    // EXPIRE_CHALLENGE_BLOCKS window at that point. This test both proves the
    // rejection while blocked AND that the round gets a genuine, fresh window
    // once it's actually the front.
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // round 1 closes, round 2 opens
    buy_ticket(&mut deps, &env, "player3").unwrap();
    buy_ticket(&mut deps, &env, "player4").unwrap(); // round 2 closes, round 3 opens

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);

    // Round 2 is Closed and overdue too, but round 1 is still the front -
    // both steps must reject it.
    let err = execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 2 }).unwrap_err();
    assert!(matches!(err, ContractError::QueueMismatch { front: 1, round_id: 2 }));

    // Resolve round 1 normally (the operator finally reveals it) - this pops
    // the queue, making round 2 the front.
    reveal(&mut deps, &overdue_env, 1, 1).unwrap();
    assert_eq!(round_history(&deps, &overdue_env, 1).status, RoundStatus::Drawn);

    // A FinalizeExpireClosedRound{2} attempt still fails - no request was ever
    // made (rejected above), regardless of front-of-queue status now.
    let err = execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedRound { round_id: 2 }).unwrap_err();
    assert!(matches!(err, ContractError::ExpireNotRequested { round_id: 2 }));

    // Now that round 2 is genuinely the front, the real 3-phase clock can
    // start, and gets its own full window from here - not zero.
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 2 }).unwrap();
    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedRound { round_id: 2 }).unwrap();
    assert_eq!(round_history(&deps, &finalize_env, 2).status, RoundStatus::ExpiryPending);

    // Genuine, un-consumed challenge window: claiming right at finalize fails.
    let err = execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 2 }).unwrap_err();
    assert!(matches!(err, ContractError::ChallengeWindowOpen { .. }));

    let mut claim_env = finalize_env.clone();
    claim_env.block.height += EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS;
    execute(deps.as_mut(), claim_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 2 }).unwrap();
    assert_eq!(round_history(&deps, &claim_env, 2).status, RoundStatus::Expired);
}

#[test]
fn claim_expired_round_correctly_routes_a_nonzero_carried_in_amount_to_the_next_round() {
    // Round 1 reveals normally, carrying 5% of its pool into round 2 via
    // route_carry. Round 2 then closes but is NEVER revealed - it goes
    // through the full 3-phase expiration instead. claim_expired_round's own
    // carry_forward for round 2 (pool minus what's owed to its own ticket
    // buyers) must include that carried-in amount from round 1, and must
    // route it onward to round 3 correctly - this is the exact class of
    // STATE-save-ordering bug (Fix L) that surfaced for real in
    // weekly-round's analogous path, caught by a similar test there.
    let (mut deps, env) = setup_and_seed(2, 2, 5);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap(); // round 1 closes, round 2 opens
    reveal(&mut deps, &env, 1, 1).unwrap(); // 5% of 2_000_000 = 100_000 carried into round 2

    let round2_before = current_round(&deps, &env);
    assert_eq!(round2_before.round_id, 2);
    assert_eq!(round2_before.pool, Uint128::new(100_000));

    buy_ticket(&mut deps, &env, "player3").unwrap();
    buy_ticket(&mut deps, &env, "player4").unwrap(); // round 2 closes (pool = 100_000 carry + 2_000_000 tickets), round 3 opens

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 2 }).unwrap();
    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedRound { round_id: 2 }).unwrap();
    let mut claim_env = finalize_env.clone();
    claim_env.block.height += EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS;
    let res = execute(deps.as_mut(), claim_env.clone(), mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 2 }).unwrap();

    // carry_forward = pool (2_100_000) - tickets_value (2_000_000) = 100_000
    let carried_attr = res.attributes.iter().find(|a| a.key == "carried_forward").unwrap();
    assert_eq!(carried_attr.value, "100000");

    let round3 = current_round(&deps, &claim_env);
    assert_eq!(round3.round_id, 3);
    assert_eq!(round3.pool, Uint128::new(100_000));

    // Round 2's own ticket buyers still get their exact money back, on top
    // of the carry having moved on - the carry was never theirs.
    let round2_after = round_history(&deps, &claim_env, 2);
    assert_eq!(round2_after.status, RoundStatus::Expired);
    assert_eq!(round2_after.pool, Uint128::new(2_000_000));
}

#[test]
fn a_legitimate_reveal_still_rescues_a_round_already_in_expiry_pending() {
    let (mut deps, env) = setup_and_seed(2, 2, 3);
    buy_ticket(&mut deps, &env, "player1").unwrap();
    buy_ticket(&mut deps, &env, "player2").unwrap();

    let mut overdue_env = env.clone();
    overdue_env.block.time = overdue_env.block.time.plus_seconds(MAX_REVEAL_AGE_SECONDS);
    execute(deps.as_mut(), overdue_env.clone(), mock_info("anyone", &[]), ExecuteMsg::RequestExpireClosedRound { round_id: 1 }).unwrap();
    let mut finalize_env = overdue_env.clone();
    finalize_env.block.height += EXPIRE_FINALIZE_DELAY_BLOCKS;
    execute(deps.as_mut(), finalize_env.clone(), mock_info("anyone", &[]), ExecuteMsg::FinalizeExpireClosedRound { round_id: 1 }).unwrap();
    assert_eq!(round_history(&deps, &finalize_env, 1).status, RoundStatus::ExpiryPending);

    // Still inside the challenge window - the operator finally shows up with
    // the real reveal, which must succeed and clear the pending-expiry state.
    let res = reveal(&mut deps, &finalize_env, 1, 1).unwrap();
    assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "reveal_draw"));
    let round1 = round_history(&deps, &finalize_env, 1);
    assert_eq!(round1.status, RoundStatus::Drawn);
    assert!(round1.winner.is_some());

    // ClaimExpiredRound can no longer apply - the round already resolved.
    let mut claim_env = finalize_env.clone();
    claim_env.block.height += EXPIRE_CHALLENGE_BLOCKS;
    let err = execute(deps.as_mut(), claim_env, mock_info("anyone", &[]), ExecuteMsg::ClaimExpiredRound { round_id: 1 }).unwrap_err();
    assert!(matches!(err, ContractError::NothingToReveal {}));
}
