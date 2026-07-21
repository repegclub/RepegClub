use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Reply, Response, StdResult};
use cw_utils::parse_reply_instantiate_data;

use crate::error::ContractError;
use crate::execute::{execute_create_raffle, CREATE_RAFFLE_REPLY_ID};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{RaffleRecord, PENDING_CREATOR, RAFFLES, RAFFLE_CODE_ID, RAFFLE_COUNT};

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    RAFFLE_CODE_ID.save(deps.storage, &msg.raffle_code_id)?;
    RAFFLE_COUNT.save(deps.storage, &0u64)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("raffle_code_id", msg.raffle_code_id.to_string()))
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
            draw_delay_blocks,
            draw_window_blocks,
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
            draw_delay_blocks,
            draw_window_blocks,
            unclaimed_deadline_days,
            prize_native_denom,
            prize_cw20_address,
            podium_shares_bps,
        ),
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
        coins, from_json, Addr, CosmosMsg, SubMsgResponse, SubMsgResult, Uint128, WasmMsg,
    };

    use crate::msg::{ExecuteMsg, RaffleRecordResponse, RaffleType, RafflesResponse};
    use crate::state::PENDING_CREATOR;

    const RAFFLE_CODE_ID: u64 = 42;

    fn sample_create_raffle_msg() -> ExecuteMsg {
        ExecuteMsg::CreateRaffle {
            raffle_type: RaffleType::SingleWinner,
            ticket_price: Uint128::new(1_000_000),
            ticket_denom: "uusdc".to_string(),
            allowed_entrants: None,
            min_players: 2,
            max_players: 10,
            round_timeout_seconds: 3600,
            draw_delay_blocks: 2,
            draw_window_blocks: 60,
            unclaimed_deadline_days: 90,
            prize_native_denom: Some("uustc".to_string()),
            prize_cw20_address: None,
            podium_shares_bps: vec![],
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
                ..
            }) => {
                assert_eq!(*admin, None);
                assert_eq!(*code_id, RAFFLE_CODE_ID);
                assert!(funds.is_empty());
                assert_eq!(label, "repeg-club-raffle-0");
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
            },
        )
        .unwrap();

        let err = reply(deps.as_mut(), mock_env(), fake_reply(999, "terra1whatever")).unwrap_err();
        assert!(matches!(err, ContractError::UnknownReplyId { id: 999 }));
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
}
