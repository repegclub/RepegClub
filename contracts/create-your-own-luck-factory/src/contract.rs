use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Empty, Env, MessageInfo, Reply, Response, StdResult};
use cw_utils::parse_reply_instantiate_data;

use crate::error::ContractError;
use crate::execute::{
    execute_add_cw20_to_whitelist, execute_consume_commit, execute_create_raffle, execute_push_commits,
    execute_remove_cw20_from_whitelist, execute_report_cw20_failure, execute_return_commit,
    execute_set_cancellation_penalty_bps, execute_unblacklist_cw20, CREATE_RAFFLE_REPLY_ID,
};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{
    RaffleRecord, ADMIN, CANCELLATION_PENALTY_BASE_BPS, CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS, COMMIT_PUSHER,
    KNOWN_RAFFLES, PENDING_CREATOR, RAFFLES, RAFFLE_CODE_ID, RAFFLE_COUNT,
};

/// Starting cancellation-penalty split (20% forfeited on any cancel once
/// the fee is paid, another 80% - 100% total - once `min_players` is
/// reached) - the exact figures confirmed with the user, 2026-08-20. Admin-
/// updatable from here via `SetCancellationPenaltyBps`.
const DEFAULT_CANCELLATION_PENALTY_BASE_BPS: u64 = 2_000;
const DEFAULT_CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS: u64 = 8_000;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    RAFFLE_CODE_ID.save(deps.storage, &msg.raffle_code_id)?;
    RAFFLE_COUNT.save(deps.storage, &0u64)?;
    ADMIN.save(deps.storage, &info.sender)?;
    COMMIT_PUSHER.save(deps.storage, &deps.api.addr_validate(&msg.commit_pusher)?)?;
    CANCELLATION_PENALTY_BASE_BPS.save(deps.storage, &DEFAULT_CANCELLATION_PENALTY_BASE_BPS)?;
    CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS
        .save(deps.storage, &DEFAULT_CANCELLATION_PENALTY_LATE_ADDITIONAL_BPS)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("raffle_code_id", msg.raffle_code_id.to_string())
        .add_attribute("admin", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::CreateRaffle {
            raffle_type,
            ticket_price,
            ticket_denom,
            allowed_entrants,
            min_players,
            max_players,
            round_timeout_seconds,
            unclaimed_deadline_days,
            prize_native_denom,
            prize_cw20_address,
            podium_shares_bps,
        } => execute_create_raffle(
            deps,
            env,
            info,
            raffle_type,
            ticket_price,
            ticket_denom,
            allowed_entrants,
            min_players,
            max_players,
            round_timeout_seconds,
            unclaimed_deadline_days,
            prize_native_denom,
            prize_cw20_address,
            podium_shares_bps,
        ),
        ExecuteMsg::AddCw20ToWhitelist { address } => execute_add_cw20_to_whitelist(deps, info, address),
        ExecuteMsg::RemoveCw20FromWhitelist { address } => {
            execute_remove_cw20_from_whitelist(deps, info, address)
        }
        ExecuteMsg::UnblacklistCw20 { address } => execute_unblacklist_cw20(deps, info, address),
        ExecuteMsg::ReportCw20Failure { address } => execute_report_cw20_failure(deps, info, address),
        ExecuteMsg::SetCancellationPenaltyBps {
            base_bps,
            late_additional_bps,
        } => execute_set_cancellation_penalty_bps(deps, info, base_bps, late_additional_bps),
        ExecuteMsg::PushCommits { commits } => execute_push_commits(deps, info, commits),
        ExecuteMsg::ConsumeCommit {} => execute_consume_commit(deps, info),
        ExecuteMsg::ReturnCommit {} => execute_return_commit(deps, info),
    }
}

#[entry_point]
pub fn reply(deps: DepsMut, env: Env, msg: Reply) -> Result<Response, ContractError> {
    match msg.id {
        CREATE_RAFFLE_REPLY_ID => handle_create_raffle_reply(deps, env, msg),
        id => Err(ContractError::UnknownReplyId { id }),
    }
}

fn handle_create_raffle_reply(
    deps: DepsMut,
    env: Env,
    msg: Reply,
) -> Result<Response, ContractError> {
    let res = parse_reply_instantiate_data(msg).map_err(|e| ContractError::ReplyParse(e.to_string()))?;
    let raffle_address = deps.api.addr_validate(&res.contract_address)?;

    let creator = PENDING_CREATOR.load(deps.storage)?;
    PENDING_CREATOR.remove(deps.storage);

    let index = RAFFLE_COUNT.load(deps.storage)?;
    RAFFLES.save(
        deps.storage,
        index,
        &RaffleRecord {
            address: raffle_address.clone(),
            creator: creator.clone(),
            created_at: env.block.time,
        },
    )?;
    RAFFLE_COUNT.save(deps.storage, &(index + 1))?;
    KNOWN_RAFFLES.save(deps.storage, &raffle_address, &Empty {})?;

    Ok(Response::new()
        .add_attribute("action", "raffle_created")
        .add_attribute("raffle_address", raffle_address)
        .add_attribute("creator", creator))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{
        coins, from_json, Addr, CosmosMsg, HexBinary, SubMsgResponse, SubMsgResult, Uint128, WasmMsg,
    };

    use crate::msg::{CreatorCooldownResponse, ExecuteMsg, QueryMsg, RaffleRecordResponse, RaffleType, RafflesResponse};
    use crate::state::PENDING_CREATOR;

    const RAFFLE_CODE_ID: u64 = 42;

    fn sample_create_raffle_msg() -> ExecuteMsg {
        // Paid, SingleWinner, max_players=10 - below UNSAFE_MAX_PLAYERS_THRESHOLD
        // (20), so this is itself an "unsafe-shaped" raffle for the cooldown
        // tests below, same as every other test already using it.
        ExecuteMsg::CreateRaffle {
            raffle_type: RaffleType::SingleWinner,
            ticket_price: Uint128::new(1_000_000),
            ticket_denom: "uusdc".to_string(),
            allowed_entrants: None,
            min_players: 2,
            max_players: 10,
            round_timeout_seconds: 3600,
            unclaimed_deadline_days: 90,
            prize_native_denom: Some("uustc".to_string()),
            prize_cw20_address: None,
            podium_shares_bps: vec![],
        }
    }

    fn safe_raffle_msg() -> ExecuteMsg {
        // >= UNSAFE_MAX_PLAYERS_THRESHOLD (20) - safe shape despite being paid.
        match sample_create_raffle_msg() {
            ExecuteMsg::CreateRaffle {
                raffle_type,
                ticket_price,
                ticket_denom,
                allowed_entrants,
                min_players,
                round_timeout_seconds,
                unclaimed_deadline_days,
                prize_native_denom,
                prize_cw20_address,
                podium_shares_bps,
                ..
            } => ExecuteMsg::CreateRaffle {
                raffle_type,
                ticket_price,
                ticket_denom,
                allowed_entrants,
                min_players,
                max_players: 50,
                round_timeout_seconds,
                unclaimed_deadline_days,
                prize_native_denom,
                prize_cw20_address,
                podium_shares_bps,
            },
            _ => unreachable!("sample_create_raffle_msg always returns CreateRaffle"),
        }
    }

    fn free_raffle_msg() -> ExecuteMsg {
        // ticket_price=0 - never an unsafe shape, regardless of max_players.
        match sample_create_raffle_msg() {
            ExecuteMsg::CreateRaffle {
                raffle_type,
                ticket_denom,
                allowed_entrants,
                min_players,
                max_players,
                round_timeout_seconds,
                unclaimed_deadline_days,
                prize_native_denom,
                prize_cw20_address,
                podium_shares_bps,
                ..
            } => ExecuteMsg::CreateRaffle {
                raffle_type,
                ticket_price: Uint128::zero(),
                ticket_denom,
                allowed_entrants,
                min_players,
                max_players,
                round_timeout_seconds,
                unclaimed_deadline_days,
                prize_native_denom,
                prize_cw20_address,
                podium_shares_bps,
            },
            _ => unreachable!("sample_create_raffle_msg always returns CreateRaffle"),
        }
    }

    fn airdrop_paid_raffle_msg() -> ExecuteMsg {
        // Airdrop - never an unsafe shape, even paid + small max_players.
        match sample_create_raffle_msg() {
            ExecuteMsg::CreateRaffle {
                ticket_price,
                ticket_denom,
                allowed_entrants,
                min_players,
                max_players,
                round_timeout_seconds,
                unclaimed_deadline_days,
                prize_native_denom,
                prize_cw20_address,
                podium_shares_bps,
                ..
            } => ExecuteMsg::CreateRaffle {
                raffle_type: RaffleType::Airdrop,
                ticket_price,
                ticket_denom,
                allowed_entrants,
                min_players,
                max_players,
                round_timeout_seconds,
                unclaimed_deadline_days,
                prize_native_denom,
                prize_cw20_address,
                podium_shares_bps,
            },
            _ => unreachable!("sample_create_raffle_msg always returns CreateRaffle"),
        }
    }

    /// Manually encodes the same minimal protobuf shape cw-utils'
    /// `parse_instantiate_response_data` decodes: field 1 (contract_address)
    /// as a length-delimited string, no field 2. Terra addresses are well
    /// under 128 bytes, so a single-byte varint length always fits.
    fn encode_instantiate_reply_data(contract_address: &str) -> Binary {
        assert!(contract_address.len() < 128);
        let mut bytes = vec![0x0a, contract_address.len() as u8];
        bytes.extend_from_slice(contract_address.as_bytes());
        Binary(bytes)
    }

    fn fake_reply(id: u64, contract_address: &str) -> Reply {
        Reply {
            id,
            result: SubMsgResult::Ok(SubMsgResponse {
                events: vec![],
                data: Some(encode_instantiate_reply_data(contract_address)),
            }),
        }
    }

    #[test]
    fn create_raffle_dispatches_the_right_submsg() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                raffle_code_id: RAFFLE_CODE_ID,
                commit_pusher: "committer".to_string(),
            },
        )
        .unwrap();

        let res = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("creator1", &[]),
            sample_create_raffle_msg(),
        )
        .unwrap();

        assert_eq!(res.messages.len(), 1);
        let sub_msg = &res.messages[0];
        assert_eq!(sub_msg.id, CREATE_RAFFLE_REPLY_ID);
        match &sub_msg.msg {
            CosmosMsg::Wasm(WasmMsg::Instantiate {
                admin,
                code_id,
                funds,
                label,
                msg,
            }) => {
                assert_eq!(*admin, None);
                assert_eq!(*code_id, RAFFLE_CODE_ID);
                assert!(funds.is_empty());
                assert_eq!(label, "repeg-club-raffle-0");
                // Regression check (2026-07-23): the raffle's own info.sender
                // at instantiate time would be this factory's address, not
                // "creator1" - without an explicit creator field carrying the
                // real caller through, DepositPrize/DrawWinner/etc. would be
                // permanently unreachable for every raffle this factory
                // creates. See create-your-own-luck's own
                // explicit_creator_field_overrides_info_sender test for the
                // other half of this fix.
                #[derive(serde::Deserialize)]
                struct DecodedRaffleInstantiateMsg {
                    creator: Option<String>,
                }
                let decoded: DecodedRaffleInstantiateMsg = from_json(msg).unwrap();
                assert_eq!(decoded.creator.as_deref(), Some("creator1"));
            }
            other => panic!("expected WasmMsg::Instantiate, got {other:?}"),
        }

        assert_eq!(
            PENDING_CREATOR.load(&deps.storage).unwrap(),
            Addr::unchecked("creator1")
        );
    }

    #[test]
    fn create_raffle_rejects_attached_funds() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                raffle_code_id: RAFFLE_CODE_ID,
                commit_pusher: "committer".to_string(),
            },
        )
        .unwrap();

        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("creator1", &coins(1, "uusdc")),
            sample_create_raffle_msg(),
        )
        .unwrap_err();

        assert!(matches!(err, ContractError::UnexpectedFundsAttached {}));
    }

    #[test]
    fn reply_registers_the_raffle_and_clears_pending_creator() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                raffle_code_id: RAFFLE_CODE_ID,
                commit_pusher: "committer".to_string(),
            },
        )
        .unwrap();

        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("creator1", &[]),
            sample_create_raffle_msg(),
        )
        .unwrap();

        let raffle_addr = "terra1newraffle0000000000000000000000000000000";
        let res = reply(
            deps.as_mut(),
            mock_env(),
            fake_reply(CREATE_RAFFLE_REPLY_ID, raffle_addr),
        )
        .unwrap();
        assert_eq!(
            res.attributes
                .iter()
                .find(|a| a.key == "raffle_address")
                .unwrap()
                .value,
            raffle_addr
        );

        let record = RAFFLES.load(&deps.storage, 0).unwrap();
        assert_eq!(record.address, Addr::unchecked(raffle_addr));
        assert_eq!(record.creator, Addr::unchecked("creator1"));

        assert_eq!(RAFFLE_COUNT.load(&deps.storage).unwrap(), 1);
        assert!(PENDING_CREATOR.may_load(&deps.storage).unwrap().is_none());
    }

    #[test]
    fn reply_rejects_unknown_id() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                raffle_code_id: RAFFLE_CODE_ID,
                commit_pusher: "committer".to_string(),
            },
        )
        .unwrap();

        let err = reply(deps.as_mut(), mock_env(), fake_reply(999, "terra1whatever")).unwrap_err();
        assert!(matches!(err, ContractError::UnknownReplyId { id: 999 }));
    }

    fn cooldown_of(deps: &cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >, creator: &str) -> CreatorCooldownResponse {
        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::GetCreatorCooldown {
                creator: creator.to_string(),
            },
        )
        .unwrap();
        from_json(bin).unwrap()
    }

    #[test]
    fn create_raffle_rejects_a_second_unsafe_shaped_raffle_within_the_cooldown() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();

        execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();

        let err = execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap_err();
        assert!(matches!(err, ContractError::CreatorOnCooldown { .. }));

        // A different wallet is never affected by another creator's cooldown.
        execute(deps.as_mut(), mock_env(), mock_info("creator2", &[]), sample_create_raffle_msg()).unwrap();
    }

    #[test]
    fn create_raffle_allows_unsafe_shaped_raffle_again_once_the_cooldown_elapses() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();

        execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();

        let mut later_env = mock_env();
        later_env.block.time = later_env.block.time.plus_seconds(24 * 3600); // exactly the 1st-streak cooldown
        execute(deps.as_mut(), later_env, mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();
    }

    #[test]
    fn create_raffle_cooldown_grows_24_48_72_hours_for_consecutive_unsafe_raffles() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();

        let mut env = mock_env();
        for expected_hours in [24u64, 48, 72] {
            execute(deps.as_mut(), env.clone(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();

            let cooldown = cooldown_of(&deps, "creator1");
            let expected_available_at = env.block.time.plus_seconds(expected_hours * 3600).seconds();
            assert_eq!(cooldown.next_unsafe_allowed_at, Some(expected_available_at));

            env.block.time = env.block.time.plus_seconds(expected_hours * 3600); // jump exactly to when it's allowed again
        }
    }

    #[test]
    fn create_raffle_safe_shaped_raffle_never_resets_an_active_cooldown() {
        // Regression test for a real bug found by CodeRabbit (2026-07-22): an
        // earlier version reset the streak/cooldown entirely on any
        // safe-shaped raffle - since CreateRaffle needs no funds and the
        // raffle never needs to be funded/opened, a creator could wipe an
        // active cooldown for free with a single throwaway safe-shaped
        // raffle, fully defeating the cooldown. A safe-shaped raffle must
        // never clear or shorten an active cooldown.
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();

        execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap(); // streak 1, 24h cooldown

        // A safe-shaped raffle is never blocked, but must not touch the
        // active cooldown at all.
        execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), safe_raffle_msg()).unwrap();
        let cooldown = cooldown_of(&deps, "creator1");
        assert_eq!(cooldown.unsafe_streak, 1);
        assert!(cooldown.next_unsafe_allowed_at.is_some());

        // The cooldown is still active - a 2nd unsafe-shaped raffle right
        // after the "reset attempt" must still be rejected.
        let err = execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap_err();
        assert!(matches!(err, ContractError::CreatorOnCooldown { .. }));
    }

    #[test]
    fn create_raffle_unsafe_streak_starts_over_after_a_long_dormant_period() {
        // Ungameable forgiveness: only real elapsed time resets the streak,
        // not any action the creator can take for free.
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();

        let env = mock_env();
        execute(deps.as_mut(), env.clone(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap(); // streak 1, cooldown ends at +24h

        // Just under 30 days after that cooldown ended - still climbing from
        // where it left off (streak 2, not reset).
        let mut still_recent_env = env.clone();
        still_recent_env.block.time = env.block.time.plus_seconds(24 * 3600 + 29 * 86400);
        execute(deps.as_mut(), still_recent_env, mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();
        assert_eq!(cooldown_of(&deps, "creator1").unsafe_streak, 2);

        // More than 30 days after THAT cooldown ended (streak 2 -> 48h) with
        // no unsafe attempt in between - starts over at streak 1.
        let cooldown = cooldown_of(&deps, "creator1");
        let mut dormant_env = env.clone();
        dormant_env.block.time =
            cosmwasm_std::Timestamp::from_seconds(cooldown.next_unsafe_allowed_at.unwrap()).plus_seconds(31 * 86400);
        execute(deps.as_mut(), dormant_env, mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();
        assert_eq!(cooldown_of(&deps, "creator1").unsafe_streak, 1);
    }

    #[test]
    fn create_raffle_free_and_airdrop_raffles_are_never_unsafe_shaped() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();

        // Same tiny max_players as the "unsafe" shape, but free or Airdrop -
        // never triggers a cooldown, no matter how many times repeated.
        for _ in 0..5 {
            execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), free_raffle_msg()).unwrap();
            execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), airdrop_paid_raffle_msg()).unwrap();
        }

        let cooldown = cooldown_of(&deps, "creator1");
        assert_eq!(cooldown.unsafe_streak, 0);
        assert_eq!(cooldown.next_unsafe_allowed_at, None);
    }

    #[test]
    fn query_raffles_lists_newest_first_and_paginates() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                raffle_code_id: RAFFLE_CODE_ID,
                commit_pusher: "committer".to_string(),
            },
        )
        .unwrap();

        let addresses = [
            "terra1raffleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "terra1rafflebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "terra1rafflecccccccccccccccccccccccccccccccccccc",
        ];
        for (i, addr) in addresses.iter().enumerate() {
            execute(
                deps.as_mut(),
                mock_env(),
                mock_info(&format!("creator{i}"), &[]),
                sample_create_raffle_msg(),
            )
            .unwrap();
            reply(
                deps.as_mut(),
                mock_env(),
                fake_reply(CREATE_RAFFLE_REPLY_ID, addr),
            )
            .unwrap();
        }

        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::GetRaffles {
                start_after: None,
                limit: Some(2),
            },
        )
        .unwrap();
        let page1: RafflesResponse = from_json(bin).unwrap();
        assert_eq!(page1.total_count, 3);
        assert_eq!(page1.raffles.len(), 2);
        // Newest first: index 2 (addresses[2]) then index 1 (addresses[1]).
        assert_eq!(page1.raffles[0].index, 2);
        assert_eq!(page1.raffles[0].address, Addr::unchecked(addresses[2]));
        assert_eq!(page1.raffles[1].index, 1);

        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::GetRaffles {
                start_after: Some(page1.raffles[1].index),
                limit: Some(2),
            },
        )
        .unwrap();
        let page2: RafflesResponse = from_json(bin).unwrap();
        assert_eq!(page2.raffles.len(), 1);
        let last: RaffleRecordResponse = page2.raffles[0].clone();
        assert_eq!(last.index, 0);
        assert_eq!(last.address, Addr::unchecked(addresses[0]));
    }

    fn instantiate_factory(deps: cosmwasm_std::DepsMut) {
        instantiate(
            deps,
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg { raffle_code_id: RAFFLE_CODE_ID, commit_pusher: "committer".to_string() },
        )
        .unwrap();
    }

    #[test]
    fn admin_can_manage_the_cw20_whitelist_but_nobody_else_can() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());

        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("not-admin", &[]),
            ExecuteMsg::AddCw20ToWhitelist { address: "terra1cw20token00000000000000000000000000000000".to_string() },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::AddCw20ToWhitelist { address: "terra1cw20token00000000000000000000000000000000".to_string() },
        )
        .unwrap();

        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::IsCw20Whitelisted { address: "terra1cw20token00000000000000000000000000000000".to_string() },
        )
        .unwrap();
        assert!(from_json::<bool>(bin).unwrap());

        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("not-admin", &[]),
            ExecuteMsg::RemoveCw20FromWhitelist { address: "terra1cw20token00000000000000000000000000000000".to_string() },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::RemoveCw20FromWhitelist { address: "terra1cw20token00000000000000000000000000000000".to_string() },
        )
        .unwrap();

        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::IsCw20Whitelisted { address: "terra1cw20token00000000000000000000000000000000".to_string() },
        )
        .unwrap();
        assert!(!from_json::<bool>(bin).unwrap());
    }

    #[test]
    fn only_a_raffle_this_factory_deployed_can_report_a_cw20_failure() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());

        // A wallet that never went through CreateRaffle - not in KNOWN_RAFFLES.
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("random-wallet", &[]),
            ExecuteMsg::ReportCw20Failure { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        // Register a real raffle the same way CreateRaffle's reply does.
        execute(deps.as_mut(), mock_env(), mock_info("creator1", &[]), sample_create_raffle_msg()).unwrap();
        let raffle_addr = "terra1newraffle0000000000000000000000000000000";
        reply(deps.as_mut(), mock_env(), fake_reply(CREATE_RAFFLE_REPLY_ID, raffle_addr)).unwrap();

        // Even the admin can't call this directly - only a known raffle address.
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::ReportCw20Failure { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(raffle_addr, &[]),
            ExecuteMsg::ReportCw20Failure { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap();

        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::IsCw20Blacklisted { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap();
        assert!(from_json::<bool>(bin).unwrap());

        // Admin can manually clear a wrongly-caught token.
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("not-admin", &[]),
            ExecuteMsg::UnblacklistCw20 { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::UnblacklistCw20 { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap();

        let bin = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::IsCw20Blacklisted { address: "terra1badtoken000000000000000000000000000000000".to_string() },
        )
        .unwrap();
        assert!(!from_json::<bool>(bin).unwrap());
    }

    #[test]
    fn cancellation_penalty_bps_defaults_20_80_and_is_admin_tunable_within_100_percent() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());

        let bin = query(deps.as_ref(), mock_env(), QueryMsg::GetCancellationPenaltyBps {}).unwrap();
        let penalty: crate::msg::CancellationPenaltyResponse = from_json(bin).unwrap();
        assert_eq!(penalty.base_bps, 2_000);
        assert_eq!(penalty.late_additional_bps, 8_000);

        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("not-admin", &[]),
            ExecuteMsg::SetCancellationPenaltyBps { base_bps: 1_000, late_additional_bps: 9_000 },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        // Over 100% combined - rejected even for the admin.
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::SetCancellationPenaltyBps { base_bps: 5_000, late_additional_bps: 6_000 },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::InvalidCancellationPenaltyBps {}));

        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::SetCancellationPenaltyBps { base_bps: 1_000, late_additional_bps: 9_000 },
        )
        .unwrap();

        let bin = query(deps.as_ref(), mock_env(), QueryMsg::GetCancellationPenaltyBps {}).unwrap();
        let penalty: crate::msg::CancellationPenaltyResponse = from_json(bin).unwrap();
        assert_eq!(penalty.base_bps, 1_000);
        assert_eq!(penalty.late_additional_bps, 9_000);
    }

    /// Registers a raffle the same way `CreateRaffle`'s own reply does (see
    /// `only_a_raffle_this_factory_deployed_can_report_a_cw20_failure` above
    /// for the pattern this mirrors), returning its address for `ConsumeCommit`/
    /// `ReturnCommit` tests below - both are authenticated via `KNOWN_RAFFLES`,
    /// the same set this populates.
    fn known_raffle(deps: cosmwasm_std::DepsMut) -> Addr {
        known_raffle_at(deps, "terra1newraffle0000000000000000000000000000000", "creator1")
    }

    fn known_raffle_at(mut deps: cosmwasm_std::DepsMut, raffle_addr: &str, creator: &str) -> Addr {
        execute(deps.branch(), mock_env(), mock_info(creator, &[]), sample_create_raffle_msg()).unwrap();
        reply(deps.branch(), mock_env(), fake_reply(CREATE_RAFFLE_REPLY_ID, raffle_addr)).unwrap();
        Addr::unchecked(raffle_addr)
    }

    #[test]
    fn push_commits_requires_commit_pusher() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("not-admin", &[]),
            ExecuteMsg::PushCommits { commits: vec![HexBinary::from([1u8; 32])] },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        // "deployer" is ADMIN (the instantiate sender) but not COMMIT_PUSHER
        // ("committer" - see `instantiate_factory`) - must not be able to
        // push commits even though it's the highest-privilege wallet in
        // every other respect.
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            ExecuteMsg::PushCommits { commits: vec![HexBinary::from([1u8; 32])] },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }

    #[test]
    fn push_commits_rejects_wrong_length_and_empty_or_oversized_batches() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());

        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("committer", &[]),
            ExecuteMsg::PushCommits { commits: vec![HexBinary::from([1u8; 31])] },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::InvalidCommitLength {}));

        let err = execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![] })
            .unwrap_err();
        assert!(matches!(err, ContractError::InvalidCommitBatch { .. }));

        let too_many: Vec<HexBinary> = (0..51u16).map(|n| HexBinary::from([n as u8, (n >> 8) as u8].repeat(16))).collect();
        let err = execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: too_many })
            .unwrap_err();
        assert!(matches!(err, ContractError::InvalidCommitBatch { .. }));
    }

    #[test]
    fn push_commits_rejects_duplicates_within_a_batch_and_across_batches() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let c1 = HexBinary::from([1u8; 32]);

        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("committer", &[]),
            ExecuteMsg::PushCommits { commits: vec![c1.clone(), c1.clone()] },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::CommitAlreadyUsed {}));

        execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1.clone()] })
            .unwrap();

        // Same commit again in a later batch - rejected even though it hasn't
        // been consumed by any raffle yet, same permanent-dedup rule as
        // wheel-manager's own USED_COMMITS.
        let err = execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1] })
            .unwrap_err();
        assert!(matches!(err, ContractError::CommitAlreadyUsed {}));
    }

    #[test]
    fn consume_commit_requires_a_known_raffle() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![HexBinary::from([1u8; 32])] })
            .unwrap();

        let err = execute(deps.as_mut(), mock_env(), mock_info("random-wallet", &[]), ExecuteMsg::ConsumeCommit {}).unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }

    #[test]
    fn consume_commit_returns_the_front_of_the_queue_and_rejects_a_second_call() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let raffle_addr = known_raffle(deps.as_mut());
        let c1 = HexBinary::from([1u8; 32]);
        let c2 = HexBinary::from([2u8; 32]);
        execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1.clone(), c2] })
            .unwrap();

        let res = execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap();
        let returned: HexBinary = from_json(res.data.unwrap()).unwrap();
        assert_eq!(returned, c1, "must return the front of the queue, not any other entry");

        // Still holding c1, never returned it - a second dispatch must be
        // rejected rather than handing out c2 too (RAFFLE_COMMITS dedup).
        let err = execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap_err();
        assert!(matches!(err, ContractError::CommitAlreadyConsumed {}));
    }

    #[test]
    fn consume_commit_rejects_when_the_queue_is_empty() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let raffle_addr = known_raffle(deps.as_mut());
        // No PushCommits at all.
        let err = execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap_err();
        assert!(matches!(err, ContractError::NoCommitsAvailable {}));
    }

    #[test]
    fn return_commit_requires_a_known_raffle_and_a_previously_consumed_commit() {
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let raffle_addr = known_raffle(deps.as_mut());

        let err = execute(deps.as_mut(), mock_env(), mock_info("random-wallet", &[]), ExecuteMsg::ReturnCommit {}).unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));

        // Known raffle, but never called ConsumeCommit - nothing to return.
        let err = execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ReturnCommit {}).unwrap_err();
        assert!(matches!(err, ContractError::NoCommitToReturn {}));
    }

    #[test]
    fn return_commit_recycles_to_the_front_of_the_queue_closing_the_commit_dos() {
        // Traces the Fix J DoS from the project's Obsidian notes ("Grinding
        // vía SubMsg+reply", Ronda 9): a raffle that consumes a commit but
        // never reveals with it (cancelled with 0 players, here) must be able
        // to hand it back so the queue doesn't shrink for nothing.
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let raffle_addr = known_raffle(deps.as_mut());
        let c1 = HexBinary::from([1u8; 32]);
        let c2 = HexBinary::from([2u8; 32]);
        execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1.clone(), c2.clone()] })
            .unwrap();

        let res = execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap();
        let consumed: HexBinary = from_json(res.data.unwrap()).unwrap();
        assert_eq!(consumed, c1);

        execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ReturnCommit {}).unwrap();

        // A second ConsumeCommit (a fresh raffle, or this one again after a
        // fresh CreateRaffle in reality - reusing the same address here only
        // to keep the test focused) gets c1 back, at the front, not c2.
        let res = execute(deps.as_mut(), mock_env(), mock_info(raffle_addr.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap();
        let reconsumed: HexBinary = from_json(res.data.unwrap()).unwrap();
        assert_eq!(reconsumed, c1, "the returned commit must come back at the front of the queue");
    }

    #[test]
    fn return_commit_recycles_across_two_distinct_raffles() {
        // Ronda 10 audit fix regression test (Opus, Q14 gap #2, feeding
        // CYOL-1/critical): the factory's own mechanics have no way to know
        // WHY a commit came back, only that it did - a genuinely different
        // raffle (not the one that consumed it) can receive a recycled commit
        // via a plain ConsumeCommit call. This is exactly the step that makes
        // CYOL-1 exploitable in create-your-own-luck (a commit returned from a
        // raffle whose preimage may already be public lands on a completely
        // unrelated, healthy raffle) - the factory alone can't prevent it, the
        // fix has to be (and is, as of this same audit round) on the caller
        // side: create-your-own-luck's `claim_expired_raffle` never calls
        // `ReturnCommit` in the first place. This test only fixes the factory's
        // own recycling mechanics as observable behavior, for the record.
        let mut deps = mock_dependencies();
        instantiate_factory(deps.as_mut());
        let raffle_a = known_raffle_at(deps.as_mut(), "terra1raffleaaaa00000000000000000000000000000", "creator1");
        let raffle_b = known_raffle_at(deps.as_mut(), "terra1rafflebbbb00000000000000000000000000000", "creator2");
        let c1 = HexBinary::from([1u8; 32]);
        execute(deps.as_mut(), mock_env(), mock_info("committer", &[]), ExecuteMsg::PushCommits { commits: vec![c1.clone()] })
            .unwrap();

        let res = execute(deps.as_mut(), mock_env(), mock_info(raffle_a.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap();
        assert_eq!(from_json::<HexBinary>(res.data.unwrap()).unwrap(), c1);
        execute(deps.as_mut(), mock_env(), mock_info(raffle_a.as_str(), &[]), ExecuteMsg::ReturnCommit {}).unwrap();

        // Raffle B - unrelated to A - consumes and gets exactly c1 back.
        let res = execute(deps.as_mut(), mock_env(), mock_info(raffle_b.as_str(), &[]), ExecuteMsg::ConsumeCommit {}).unwrap();
        assert_eq!(from_json::<HexBinary>(res.data.unwrap()).unwrap(), c1);
    }
}
