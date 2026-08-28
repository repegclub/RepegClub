use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Coin, CosmosMsg, DepsMut, Empty, Env, HexBinary, MessageInfo,
    Response, Storage, Uint128, WasmMsg,
};
use sha2::{Digest, Sha256};

use crate::error::ContractError;
use crate::rand::pick_winner_index;
use crate::state::{
    GlobalState, Round, RoundStatus, CONFIG, COMMIT_QUEUE, REVEAL_QUEUE, ROUNDS, STATE,
    TOTAL_INVESTED, TOTAL_REDEEMED, USED_COMMITS, WINNER_INDEX,
};

const PRIZE_BPS: u128 = 6000; // 60%
const NEXT_ROUND_BPS: u128 = 500; // 5%
const WEEKLY_BPS: u128 = 2000; // 20%
const TREASURY_BPS: u128 = 1200; // 12%
const ADMIN_BPS: u128 = 300; // 3%
const BPS_DENOM: u128 = 10000;

/// Width, in blocks, of the "second step" wait in the 3-phase expiration -
/// how long a `RequestExpireClosedRound` has to sit before
/// `FinalizeExpireClosedRound` can transition the round to `ExpiryPending`.
/// Fixed rather than admin-configurable, same reasoning as
/// `EXPIRE_CHALLENGE_BLOCKS`/`REQUEST_EXPIRE_TTL_BLOCKS` below: this is a
/// small, well-understood grace window, not a dial that needs per-deploy
/// tuning.
pub const EXPIRE_FINALIZE_DELAY_BLOCKS: u64 = 100;
/// Width, in blocks, of the "third step" wait - how long a round can sit in
/// `ExpiryPending` while a legitimate `RevealDraw` can still rescue it,
/// before `ClaimExpiredRound` can resolve it to `Expired` instead. See the
/// project's Obsidian notes ("Grinding vía SubMsg+reply") for the accepted
/// residual risk this window is part of: it does not eliminate the
/// possibility of a front-run in the narrow post-outage-recovery window, only
/// the free/instant version of it.
pub const EXPIRE_CHALLENGE_BLOCKS: u64 = 100;
/// Extra blocks added on top of `EXPIRE_CHALLENGE_BLOCKS` before
/// `ClaimExpiredRound` becomes callable (Ronda 10 audit fix, Opus,
/// CYOL-2/WM-1 - reserves this margin exclusively for a legitimate
/// `RevealDraw`, which is valid the whole time a round is `ExpiryPending`).
/// Without this, at the exact height the challenge window elapses,
/// `RevealDraw` and `ClaimExpiredRound` are simultaneously valid and whichever
/// transaction lands first in the block wins - an attacker watching the
/// mempool for the operator's real reveal (recovering right at that moment
/// from the outage that triggered this whole path) could race a claim ahead
/// of it, forcing a healthy raffle to refund instead of draw for real, with no
/// fund loss but a free, deliberate griefing trigger. 20 blocks (~2 minutes at
/// Terra Classic's ~6s block time) is deliberately small - once the operator's
/// reveal is genuinely broadcast, it only needs enough headroom to land ahead
/// of the claim, not to cover recovery time itself (the operator is already
/// back online and transmitting by the time this matters) - so this doesn't
/// meaningfully delay a genuinely abandoned round's refund, on top of the
/// ~30 minutes `EXPIRE_FINALIZE_DELAY_BLOCKS` + `EXPIRE_CHALLENGE_BLOCKS`
/// already take.
pub const REVEAL_PRIORITY_MARGIN_BLOCKS: u64 = 20;
/// A `RequestExpireClosedRound` expires after this many blocks if
/// `FinalizeExpireClosedRound` hasn't followed - without this, a single
/// request stays "armed" forever, which is the exact hole this constant
/// exists to close.
pub const REQUEST_EXPIRE_TTL_BLOCKS: u64 = 200;
/// Bounds a single `PushCommits` batch - without this, an unbounded batch is
/// a transaction that can't fit in gas, and worse, a `COMMIT_QUEUE` that
/// grows without limit even though nothing prunes it.
pub const PUSH_COMMITS_MAX_BATCH: u32 = 50;
/// Bounds the total length of `COMMIT_QUEUE` - same reasoning, applied to the
/// cumulative total across every `PushCommits` call instead of a single one.
pub const MAX_COMMIT_QUEUE_LEN: u32 = 500;

/// Mirrors Weekly Round's `ExecuteMsg::ContributeToPool` just enough to build the
/// outbound message. Deliberately not a shared crate dependency between the two
/// contracts, so each stays independently upgradable (see project decision on
/// per-contract modularity).
#[cw_serde]
enum WeeklyRoundExecuteMsg {
    ContributeToPool {
        source_wheel: String,
        source_round_id: u64,
    },
}

/// Opens `round_id` as a fresh `Open` round, drawing the next commit from
/// `COMMIT_QUEUE` if one is available (left `None` otherwise - see
/// `Round::commit_used`'s doc comment). Rejects if a round already exists
/// under this id (defense in depth against any caller-side bug that would
/// otherwise silently overwrite a live round - see the project's Obsidian
/// notes on the Ronda 8 finding this class of bug produced once already).
pub fn open_new_round(storage: &mut dyn Storage, env: &Env, round_id: u64) -> Result<(), ContractError> {
    if ROUNDS.has(storage, round_id) {
        return Err(ContractError::RoundAlreadyExists { round_id });
    }
    let commit_used = COMMIT_QUEUE.pop_front(storage)?;
    let round = Round {
        round_id,
        status: RoundStatus::Open,
        entrants: vec![],
        unique_players: vec![],
        pool: Uint128::zero(),
        opened_at: env.block.time,
        deadline: None,
        closed_at: None,
        closed_at_height: None,
        commit_used,
        revealed_preimage: None,
        expire_requested_at_height: None,
        expiry_pending_since_height: None,
        drawn_at: None,
        winner: None,
        prize_remaining: Uint128::zero(),
        expired_at: None,
    };
    ROUNDS.save(storage, round_id, &round)?;
    Ok(())
}

/// Routes an amount of platform-owned money (nobody's individual ticket) to
/// whichever round is currently `Open`, crediting it directly and draining
/// `state.next_round_carry` to zero in the same step. If `current_round_id`
/// somehow isn't `Open` (see the invariant argued in the project's Obsidian
/// design notes: closing a round always opens its successor atomically, in
/// the same transaction, so this branch should be structurally unreachable),
/// the amount is left in `next_round_carry` for the next `route_carry` call
/// to pick up - cheap defense in depth rather than an assumption baked in as
/// fact.
pub fn route_carry(storage: &mut dyn Storage, state: &mut GlobalState, amount: Uint128) -> Result<(), ContractError> {
    if amount.is_zero() {
        return Ok(());
    }
    state.next_round_carry += amount;
    if let Some(mut current) = ROUNDS.may_load(storage, state.current_round_id)? {
        if current.status == RoundStatus::Open {
            let amt = state.next_round_carry;
            state.next_round_carry = Uint128::zero();
            current.pool += amt;
            ROUNDS.save(storage, current.round_id, &current)?;
        }
    }
    Ok(())
}

/// No single wallet may hold more than half of a round's `max_players` worth
/// of tickets - bounds the worst-case size of `entrants` (so
/// `pick_winner_index`'s hash can never grow unbounded and become ungasable)
/// while still leaving room for the weighted-wheel "buy more, better odds"
/// feature. Not a separate config field on purpose - always derived from
/// `max_players` so there's nothing extra to misconfigure.
pub fn max_tickets_per_wallet(max_players: u32) -> u32 {
    std::cmp::max(1, max_players / 2)
}

pub fn execute_buy_ticket(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }
    // Structural gate (v9): a round with any entrant always has a commit -
    // see Round::commit_used's doc comment. Checked before any mutation.
    if round.commit_used.is_none() {
        return Err(ContractError::RoundNotSeeded {});
    }

    // Once the round is stale (never reached min_players within
    // max_round_age_seconds), stop accepting tickets - it must go through
    // ExpireRound + ReclaimTicket instead, not keep growing indefinitely.
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    let stale = !has_min
        && env.block.time.seconds() >= round.opened_at.seconds() + config.max_round_age_seconds;
    if stale {
        return Err(ContractError::RoundExpired {});
    }

    let sent_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.ticket_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if sent_amount != config.ticket_price {
        return Err(ContractError::WrongTicketPayment {
            expected: config.ticket_price,
            denom: config.ticket_denom.clone(),
        });
    }

    let cap = max_tickets_per_wallet(config.max_players);
    let already_bought = round.entrants.iter().filter(|e| **e == info.sender).count() as u32;
    if already_bought >= cap {
        return Err(ContractError::TicketCapExceeded { max_per_wallet: cap });
    }

    round.entrants.push(info.sender.clone());
    round.pool += sent_amount;
    if !round.unique_players.contains(&info.sender) {
        round.unique_players.push(info.sender.clone());
    }

    // Rolling "soft close" deadline: once min_players is reached, every
    // further ticket purchase (from anyone, new player or not) pushes the
    // close deadline forward by another round_timeout_seconds - the round
    // only actually becomes closeable once nobody buys for a full window.
    if round.unique_players.len() as u32 >= config.min_players {
        round.deadline = Some(env.block.time.plus_seconds(config.round_timeout_seconds));
    }

    let auto_closed = round.unique_players.len() as u32 >= config.max_players;
    if auto_closed {
        // Sold out - close right here, in the same atomic transaction as the
        // ticket purchase that completed the cap, and open the next round
        // immediately (v9: this branch never draws - see
        // close_round_and_advance's doc comment for why decoupling "close"
        // from "reveal" closes the original grinding hole for this path too,
        // not just the separate RevealDraw call).
        close_round_and_advance(deps.storage, &env, &mut state, &mut round)?;
        STATE.save(deps.storage, &state)?;
    } else {
        ROUNDS.save(deps.storage, round.round_id, &round)?;
    }
    add_invested(deps.storage, &info.sender, sent_amount)?;

    Ok(Response::new()
        .add_attribute("action", "buy_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("round_id", round.round_id.to_string())
        .add_attribute("pool", round.pool.to_string())
        .add_attribute("auto_closed", auto_closed.to_string()))
}

/// Shared by `execute_close_round` and `execute_buy_ticket`'s sold-out
/// branch: transitions `round` to `Closed`, enqueues it in `REVEAL_QUEUE`,
/// and opens its successor atomically in the same transaction. Deliberately
/// does nothing else - no winner-picking, no payout - so there's exactly one
/// place in the contract that can draw a winner (`execute_reveal_draw`) and
/// exactly one place that opens a round from a close (here), instead of the
/// pre-v9 shape where a single `perform_draw` did both and was called from
/// two sites with different needs (see the project's Obsidian design notes
/// on why that shared-entry-point shape was the root cause of a real
/// Ronda 8 finding).
fn close_round_and_advance(
    storage: &mut dyn Storage,
    env: &Env,
    state: &mut GlobalState,
    round: &mut Round,
) -> Result<(), ContractError> {
    round.status = RoundStatus::Closed;
    round.closed_at = Some(env.block.time);
    round.closed_at_height = Some(env.block.height);
    ROUNDS.save(storage, round.round_id, round)?;
    REVEAL_QUEUE.push_back(storage, &round.round_id)?;

    state.current_round_id += 1;
    open_new_round(storage, env, state.current_round_id)?;
    Ok(())
}

pub fn execute_close_round(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }

    let reached_max = round.unique_players.len() as u32 >= config.max_players;
    // `deadline` is only ever set once min_players is reached (see
    // execute_buy_ticket), so checking it alone already implies has_min.
    let deadline_passed = round.deadline.is_some_and(|d| env.block.time >= d);
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    // Hard ceiling on how long the rolling deadline can keep getting pushed
    // forward by new tickets - forces a close regardless, once min_players
    // was reached. If min_players was *never* reached, this same age
    // threshold is handled by ExpireRound instead, not here.
    let hard_cap_passed =
        env.block.time.seconds() >= round.opened_at.seconds() + config.max_round_age_seconds;

    if !(reached_max || deadline_passed || (has_min && hard_cap_passed)) {
        return Err(ContractError::CannotCloseRound {});
    }

    let round_id = round.round_id;
    close_round_and_advance(deps.storage, &env, &mut state, &mut round)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "close_round")
        .add_attribute("round_id", round_id.to_string()))
}

/// Permissionless. Only fires when `min_players` was never reached and
/// `max_round_age_seconds` has elapsed - the counterpart to `CloseRound` for
/// a round that never got enough interest. Opens the next round immediately
/// so the game isn't stuck waiting on this one to be resolved. This round
/// never entered `REVEAL_QUEUE` (it never reached `Closed`), so unlike
/// `claim_expired_round` this is the one place that's still correct to open
/// a successor itself.
pub fn execute_expire_round(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }
    let has_min = round.unique_players.len() as u32 >= config.min_players;
    let age_reached =
        env.block.time.seconds() >= round.opened_at.seconds() + config.max_round_age_seconds;
    if has_min || !age_reached {
        return Err(ContractError::CannotExpireRound {});
    }

    let (tickets_value, carry_forward) = split_pool_for_expiry(&config, &round);
    round.pool = tickets_value;
    round.status = RoundStatus::Expired;
    round.expired_at = Some(env.block.time);
    let finished_round_id = round.round_id;
    ROUNDS.save(deps.storage, round.round_id, &round)?;

    state.current_round_id += 1;
    let new_round_id = state.current_round_id;
    open_new_round(deps.storage, &env, new_round_id)?;
    route_carry(deps.storage, &mut state, carry_forward)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "expire_round")
        .add_attribute("round_id", finished_round_id.to_string())
        .add_attribute("reclaimable_pool", tickets_value.to_string())
        .add_attribute("carried_forward", carry_forward.to_string()))
}

/// Splits a round's pool into what's owed to specific ticket buyers
/// (reclaimable) versus everything else (carried-in money from a previous
/// round's 5% cut, nobody's individual ticket - rolls forward via
/// `route_carry` instead of sitting stranded). Shared by
/// `execute_expire_round` (Open, never reached min_players) and
/// `claim_expired_round` (Closed/ExpiryPending, reached min_players but
/// never revealed) - the only thing that differs between those two callers
/// is what happens to `state.current_round_id` afterward (see each
/// function's own doc comment), never this calculation.
fn split_pool_for_expiry(config: &crate::state::Config, round: &Round) -> (Uint128, Uint128) {
    let tickets_value = config.ticket_price * Uint128::from(round.entrants.len() as u128);
    let carry_forward = round.pool.checked_sub(tickets_value).unwrap_or_default();
    (tickets_value, carry_forward)
}

/// Callable by any wallet that bought at least one ticket in an `Expired`
/// round - refunds exactly what that wallet paid and removes its entries
/// from the round, so it can't be reclaimed twice.
pub fn execute_reclaim_ticket(
    deps: DepsMut,
    info: MessageInfo,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    if round.status != RoundStatus::Expired {
        return Err(ContractError::RoundNotExpired { round_id });
    }

    let ticket_count = round.entrants.iter().filter(|e| **e == info.sender).count();
    if ticket_count == 0 {
        return Err(ContractError::NotAnEntrant { round_id });
    }

    let refund = config.ticket_price * Uint128::from(ticket_count as u128);
    round.entrants.retain(|e| *e != info.sender);
    round.unique_players.retain(|e| *e != info.sender);
    round.pool = round.pool.checked_sub(refund).unwrap_or_default();
    ROUNDS.save(deps.storage, round_id, &round)?;
    subtract_invested(deps.storage, &info.sender, refund)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom,
                amount: refund,
            }],
        })
        .add_attribute("action", "reclaim_ticket")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Self-service refund for a wallet's own tickets in the current round,
/// callable only while `min_players` hasn't been reached yet - deliberately
/// no minimum wait time before a second player shows up, since the player
/// can simply leave whenever they lose interest instead of being locked in.
/// Once `min_players` is reached the rolling deadline takes over and this
/// stops working, the same way `CloseRound`/`RevealDraw` treat that as the
/// point the round is genuinely "in play" for everyone in it.
pub fn execute_withdraw_ticket(
    deps: DepsMut,
    info: MessageInfo,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    if round.status != RoundStatus::Open {
        return Err(ContractError::RoundNotOpen {});
    }
    if round.unique_players.len() as u32 >= config.min_players {
        return Err(ContractError::RoundAlreadyLocked { round_id });
    }

    let ticket_count = round.entrants.iter().filter(|e| **e == info.sender).count();
    if ticket_count == 0 {
        return Err(ContractError::NotAnEntrant { round_id });
    }

    let refund = config.ticket_price * Uint128::from(ticket_count as u128);
    round.entrants.retain(|e| *e != info.sender);
    round.unique_players.retain(|e| *e != info.sender);
    round.pool = round.pool.checked_sub(refund).unwrap_or_default();
    ROUNDS.save(deps.storage, round_id, &round)?;
    subtract_invested(deps.storage, &info.sender, refund)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom,
                amount: refund,
            }],
        })
        .add_attribute("action", "withdraw_ticket")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Reveals the winner for the round at the front of `REVEAL_QUEUE` -
/// `round_id` is checked against that front as an assertion, not used as an
/// independent lookup key (see `REVEAL_QUEUE`'s doc comment for the Ronda 9
/// finding this guards against). Permissionless: nothing here depends on
/// `info.sender`, only on knowing `preimage` - see `rand::pick_winner_index`'s
/// doc comment.
pub fn execute_reveal_draw(
    deps: DepsMut,
    env: Env,
    round_id: u64,
    preimage: HexBinary,
) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != round_id {
        return Err(ContractError::QueueMismatch { front, round_id });
    }

    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, round_id)?;
    if round.status != RoundStatus::Closed && round.status != RoundStatus::ExpiryPending {
        return Err(ContractError::RoundNotRevealable {});
    }
    let commit = round.commit_used.clone().ok_or(ContractError::RoundNotSeeded {})?;
    let digest = Sha256::digest(preimage.as_slice());
    if digest.as_slice() != commit.as_slice() {
        return Err(ContractError::BadPreimage {});
    }
    if round.unique_players.is_empty() {
        // Structurally unreachable - CloseRound/the sold-out branch both
        // require has_min (min_players >= 2, enforced at instantiate) before
        // a round can reach Closed. Guarded explicitly anyway rather than
        // indexing into an empty entrants list.
        return Err(ContractError::NotEnoughPlayers { min_players: 0 });
    }

    let winner_index = pick_winner_index(&env.contract.address, round_id, preimage.as_slice(), &round.entrants);
    let winner = round.entrants[winner_index].clone();

    let gross = round.pool;
    let prize = gross.multiply_ratio(PRIZE_BPS, BPS_DENOM);
    let next_carry = gross.multiply_ratio(NEXT_ROUND_BPS, BPS_DENOM);
    let weekly_cut = gross.multiply_ratio(WEEKLY_BPS, BPS_DENOM);
    let mut treasury_cut = gross.multiply_ratio(TREASURY_BPS, BPS_DENOM);
    let admin_cut = gross.multiply_ratio(ADMIN_BPS, BPS_DENOM);
    let allocated = prize + next_carry + weekly_cut + treasury_cut + admin_cut;
    // Integer division on the 5 shares can leave a few micro-units of dust;
    // it goes to the treasury rather than being lost.
    treasury_cut += gross.checked_sub(allocated).unwrap_or_default();

    round.status = RoundStatus::Drawn;
    round.winner = Some(winner.clone());
    round.prize_remaining = prize;
    round.drawn_at = Some(env.block.time);
    round.revealed_preimage = Some(preimage);
    round.expire_requested_at_height = None;
    round.expiry_pending_since_height = None;
    let finished_round_id = round.round_id;
    ROUNDS.save(deps.storage, round.round_id, &round)?;
    REVEAL_QUEUE.pop_front(deps.storage)?; // safe: front == round_id, already confirmed above

    if !prize.is_zero() {
        add_winning(deps.storage, winner.clone(), finished_round_id)?;
    }

    let mut state = STATE.load(deps.storage)?;
    route_carry(deps.storage, &mut state, next_carry)?;
    STATE.save(deps.storage, &state)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !treasury_cut.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.treasury_address.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: treasury_cut,
                }],
            }
            .into(),
        );
    }
    if !admin_cut.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.admin_fee_address.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: admin_cut,
                }],
            }
            .into(),
        );
    }
    if !weekly_cut.is_zero() {
        messages.push(
            WasmMsg::Execute {
                contract_addr: config.weekly_round_address.to_string(),
                msg: to_json_binary(&WeeklyRoundExecuteMsg::ContributeToPool {
                    source_wheel: env.contract.address.to_string(),
                    source_round_id: finished_round_id,
                })?,
                funds: vec![Coin {
                    denom: config.ticket_denom.clone(),
                    amount: weekly_cut,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "reveal_draw")
        .add_attribute("round_id", finished_round_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("prize", prize.to_string()))
}

/// Admin-only. See `COMMIT_QUEUE`/`USED_COMMITS`'s doc comments for the
/// dedup rules this enforces.
///
/// **Operational rule, not enforced on-chain (Ronda 10 audit fix, Opus,
/// CYOL-3/medium - see `rand::pick_winner_index`'s own doc comment for why):
/// never push the same commit (`sha256(preimage)`) to more than one of this
/// project's 3 independent commit queues** (this contract's own, weekly-
/// round's, and create-your-own-luck-factory's). Each queue dedups only
/// against its own `USED_COMMITS` - nothing here stops the admin from
/// accidentally reusing a commit across contracts, and doing so would let a
/// preimage revealed in one leak the winner of whichever raffle/round/week
/// elsewhere ends up with the same commit.
pub fn execute_push_commits(
    deps: DepsMut,
    info: MessageInfo,
    commits: Vec<HexBinary>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    if commits.is_empty() || commits.len() as u32 > PUSH_COMMITS_MAX_BATCH {
        return Err(ContractError::InvalidCommitBatch { max: PUSH_COMMITS_MAX_BATCH });
    }
    let current_len = COMMIT_QUEUE.len(deps.storage)?;
    if current_len + commits.len() as u32 > MAX_COMMIT_QUEUE_LEN {
        return Err(ContractError::CommitQueueFull { max: MAX_COMMIT_QUEUE_LEN });
    }

    let mut seen_in_batch: Vec<HexBinary> = Vec::with_capacity(commits.len());
    for commit in &commits {
        if commit.len() != 32 {
            return Err(ContractError::InvalidCommitLength {});
        }
        if USED_COMMITS.has(deps.storage, commit.as_slice()) || seen_in_batch.contains(commit) {
            return Err(ContractError::CommitAlreadyUsed {});
        }
        seen_in_batch.push(commit.clone());
    }
    for commit in &commits {
        USED_COMMITS.save(deps.storage, commit.as_slice(), &Empty {})?;
        COMMIT_QUEUE.push_back(deps.storage, commit)?;
    }

    Ok(Response::new()
        .add_attribute("action", "push_commits")
        .add_attribute("count", commits.len().to_string()))
}

/// Permissionless backfill for a round that opened while `COMMIT_QUEUE` was
/// empty. Only valid while the current round is `Open` with no entrants yet
/// (so nobody bought a ticket against an unfixed commit) and doesn't already
/// have one.
pub fn execute_assign_commit(deps: DepsMut) -> Result<Response, ContractError> {
    let state = STATE.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, state.current_round_id)?;
    if round.status != RoundStatus::Open || !round.entrants.is_empty() {
        return Err(ContractError::CannotAssignCommit {});
    }
    if round.commit_used.is_some() {
        return Err(ContractError::CommitAlreadyAssigned {});
    }
    let commit = COMMIT_QUEUE.pop_front(deps.storage)?.ok_or(ContractError::NoCommitsAvailable {})?;
    round.commit_used = Some(commit);
    ROUNDS.save(deps.storage, round.round_id, &round)?;

    Ok(Response::new()
        .add_attribute("action", "assign_commit")
        .add_attribute("round_id", round.round_id.to_string()))
}

/// Permissionless. First step of the 3-phase expiration - see
/// `ExecuteMsg::RequestExpireClosedRound`'s doc comment.
///
/// Requires `round_id` to be the front of `REVEAL_QUEUE` (Ronda 10 audit fix,
/// Opus, WM-1/medium): without this, a round stuck behind an earlier
/// undrawn one could run its entire 3-phase clock "in the shadow" while
/// nobody could actually reveal or claim it yet, then become claimable the
/// instant it reaches the front - with zero real `EXPIRE_CHALLENGE_BLOCKS`
/// window once a legitimate reveal is actually possible again. Gating the
/// clock's start on being the front guarantees the reverse: the clock can
/// only start once the round is the one thing standing between the queue and
/// progress, so its full `EXPIRE_CHALLENGE_BLOCKS` window is genuine once it
/// finally elapses.
pub fn execute_request_expire_closed_round(
    deps: DepsMut,
    env: Env,
    round_id: u64,
) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != round_id {
        return Err(ContractError::QueueMismatch { front, round_id });
    }
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;
    if round.status != RoundStatus::Closed {
        return Err(ContractError::RoundNotClosedForExpiry { round_id });
    }
    let closed_at = round.closed_at.ok_or(ContractError::RoundNotClosedForExpiry { round_id })?;
    if env.block.time.seconds() < closed_at.seconds() + config.max_reveal_age_seconds {
        return Err(ContractError::RevealNotYetOverdue { round_id });
    }
    let request_live = round
        .expire_requested_at_height
        .is_some_and(|h| env.block.height < h + REQUEST_EXPIRE_TTL_BLOCKS);
    if request_live {
        return Err(ContractError::ExpireAlreadyRequested { round_id });
    }
    round.expire_requested_at_height = Some(env.block.height);
    ROUNDS.save(deps.storage, round_id, &round)?;

    Ok(Response::new()
        .add_attribute("action", "request_expire_closed_round")
        .add_attribute("round_id", round_id.to_string()))
}

/// Permissionless. Second step of the 3-phase expiration - see
/// `ExecuteMsg::FinalizeExpireClosedRound`'s doc comment. Same front-of-queue
/// requirement as `execute_request_expire_closed_round` and for the same
/// reason (Ronda 10 audit fix, Opus, WM-1/medium) - re-checked here too since
/// the round could in principle have fallen behind the front again between
/// the request and the finalize (it can't in the current design, since
/// nothing pops `REVEAL_QUEUE` except a reveal/claim of the front itself, but
/// this keeps the invariant enforced at the point it's actually relied upon
/// rather than only where it happened to be first checked).
pub fn execute_finalize_expire_closed_round(
    deps: DepsMut,
    env: Env,
    round_id: u64,
) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != round_id {
        return Err(ContractError::QueueMismatch { front, round_id });
    }
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;
    if round.status != RoundStatus::Closed {
        return Err(ContractError::RoundNotClosedForExpiry { round_id });
    }
    let requested_at = round
        .expire_requested_at_height
        .ok_or(ContractError::ExpireNotRequested { round_id })?;
    if env.block.height >= requested_at + REQUEST_EXPIRE_TTL_BLOCKS {
        return Err(ContractError::ExpireRequestExpired { round_id });
    }
    if env.block.height < requested_at + EXPIRE_FINALIZE_DELAY_BLOCKS {
        return Err(ContractError::FinalizeDelayNotElapsed { round_id });
    }
    round.status = RoundStatus::ExpiryPending;
    round.expiry_pending_since_height = Some(env.block.height);
    ROUNDS.save(deps.storage, round_id, &round)?;

    Ok(Response::new()
        .add_attribute("action", "finalize_expire_closed_round")
        .add_attribute("round_id", round_id.to_string()))
}

/// Permissionless. Final step of the 3-phase expiration - see
/// `ExecuteMsg::ClaimExpiredRound`'s doc comment. Unlike `execute_expire_round`
/// (the Open-never-reached-min-players path), this round already has its
/// successor open (it opened one atomically when it closed - see
/// `close_round_and_advance`), so this never touches `state.current_round_id`
/// or opens anything - only `route_carry`s the leftover carry-in.
pub fn claim_expired_round(deps: DepsMut, env: Env, round_id: u64) -> Result<Response, ContractError> {
    let front = REVEAL_QUEUE.front(deps.storage)?.ok_or(ContractError::NothingToReveal {})?;
    if front != round_id {
        return Err(ContractError::QueueMismatch { front, round_id });
    }
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS.load(deps.storage, round_id)?;
    if round.status != RoundStatus::ExpiryPending {
        return Err(ContractError::RoundNotExpiryPending { round_id });
    }
    let pending_since = round.expiry_pending_since_height.ok_or(ContractError::RoundNotExpiryPending { round_id })?;
    if env.block.height < pending_since + EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS {
        return Err(ContractError::ChallengeWindowOpen { round_id });
    }

    let (tickets_value, carry_forward) = split_pool_for_expiry(&config, &round);
    round.pool = tickets_value;
    round.status = RoundStatus::Expired;
    round.expired_at = Some(env.block.time);
    ROUNDS.save(deps.storage, round_id, &round)?;
    REVEAL_QUEUE.pop_front(deps.storage)?; // safe: front == round_id, already confirmed above

    let mut state = STATE.load(deps.storage)?;
    route_carry(deps.storage, &mut state, carry_forward)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "claim_expired_round")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("reclaimable_pool", tickets_value.to_string())
        .add_attribute("carried_forward", carry_forward.to_string()))
}

pub fn execute_redeem(
    deps: DepsMut,
    info: MessageInfo,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    if round.status != RoundStatus::Drawn {
        return Err(ContractError::RoundNotDrawn {});
    }
    let winner = round.winner.clone().ok_or(ContractError::RoundNotDrawn {})?;
    if info.sender != winner {
        return Err(ContractError::NotWinner { round_id });
    }
    if round.prize_remaining.is_zero() {
        return Err(ContractError::NothingToRedeem { round_id });
    }

    let sent_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.redemption_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if sent_amount.is_zero() {
        return Err(ContractError::NoFundsSent {});
    }

    let payout = std::cmp::min(sent_amount, round.prize_remaining);
    let refund = sent_amount - payout;
    round.prize_remaining -= payout;

    if round.prize_remaining.is_zero() {
        remove_winning(deps.storage, &winner, round_id)?;
    }
    ROUNDS.save(deps.storage, round_id, &round)?;
    add_redeemed(deps.storage, &winner, payout)?;

    let mut messages: Vec<CosmosMsg> = vec![BankMsg::Send {
        to_address: winner.to_string(),
        amount: vec![Coin {
            denom: config.ticket_denom.clone(),
            amount: payout,
        }],
    }
    .into()];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: winner.to_string(),
                amount: vec![Coin {
                    denom: config.redemption_denom.clone(),
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "redeem")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("winner", winner)
        .add_attribute("payout", payout.to_string())
        .add_attribute("refund", refund.to_string()))
}

pub fn execute_sweep_ustc(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    let balance = deps
        .querier
        .query_balance(&env.contract.address, config.redemption_denom.clone())?;

    if balance.amount.is_zero() {
        return Ok(Response::new()
            .add_attribute("action", "sweep_ustc")
            .add_attribute("amount", "0"));
    }

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: config.treasury_address.to_string(),
            amount: vec![balance.clone()],
        })
        .add_attribute("action", "sweep_ustc")
        .add_attribute("amount", balance.amount.to_string()))
}

/// Anyone can call this once `unclaimed_deadline_days` have passed - no admin
/// discretion, no live redirection of funds. Handles two terminal round
/// states, both measured against the same deadline window: a `Drawn` round's
/// unredeemed `prize_remaining` (from `drawn_at`), or an `Expired` round's
/// abandoned, never-reclaimed ticket pool (from `expired_at`). Either way,
/// any legitimate wallet-recovery claim is handled off-chain by the
/// (multisig) treasury from there, not by this contract.
pub fn execute_sweep_expired_prize(
    deps: DepsMut,
    env: Env,
    round_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut round = ROUNDS
        .may_load(deps.storage, round_id)?
        .ok_or(ContractError::RoundNotFound { round_id })?;

    let (swept_amount, reference_time) = match round.status {
        RoundStatus::Drawn => {
            if round.prize_remaining.is_zero() {
                return Err(ContractError::NothingToRedeem { round_id });
            }
            let drawn_at = round.drawn_at.ok_or(ContractError::RoundNotDrawn {})?;
            (round.prize_remaining, drawn_at)
        }
        RoundStatus::Expired => {
            if round.pool.is_zero() {
                return Err(ContractError::NothingToSweep { round_id });
            }
            let expired_at = round
                .expired_at
                .ok_or(ContractError::RoundNotExpired { round_id })?;
            (round.pool, expired_at)
        }
        _ => return Err(ContractError::RoundNotDrawn {}),
    };

    let deadline = reference_time.seconds() + config.unclaimed_deadline_days * 86400;
    if env.block.time.seconds() < deadline {
        return Err(ContractError::UnclaimedDeadlineNotReached { round_id });
    }

    let winner = round.winner.clone();
    match round.status {
        RoundStatus::Drawn => round.prize_remaining = Uint128::zero(),
        RoundStatus::Expired => {
            round.pool = Uint128::zero();
            round.entrants.clear();
            round.unique_players.clear();
        }
        _ => unreachable!("matched above"),
    }
    ROUNDS.save(deps.storage, round_id, &round)?;

    if let Some(winner) = winner {
        remove_winning(deps.storage, &winner, round_id)?;
    }

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: config.treasury_address.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom,
                amount: swept_amount,
            }],
        })
        .add_attribute("action", "sweep_expired_prize")
        .add_attribute("round_id", round_id.to_string())
        .add_attribute("amount", swept_amount.to_string()))
}

fn add_winning(storage: &mut dyn Storage, winner: Addr, round_id: u64) -> Result<(), ContractError> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    if !winnings.contains(&round_id) {
        winnings.push(round_id);
    }
    WINNER_INDEX.save(storage, winner, &winnings)?;
    Ok(())
}

fn remove_winning(storage: &mut dyn Storage, winner: &Addr, round_id: u64) -> Result<(), ContractError> {
    let mut winnings = WINNER_INDEX.may_load(storage, winner.clone())?.unwrap_or_default();
    winnings.retain(|id| *id != round_id);
    if winnings.is_empty() {
        WINNER_INDEX.remove(storage, winner.clone());
    } else {
        WINNER_INDEX.save(storage, winner.clone(), &winnings)?;
    }
    Ok(())
}

fn add_invested(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> Result<(), ContractError> {
    let current = TOTAL_INVESTED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_INVESTED.save(storage, wallet.clone(), &(current + amount))?;
    Ok(())
}

fn subtract_invested(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> Result<(), ContractError> {
    let current = TOTAL_INVESTED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_INVESTED.save(storage, wallet.clone(), &current.saturating_sub(amount))?;
    Ok(())
}

fn add_redeemed(storage: &mut dyn Storage, wallet: &Addr, amount: Uint128) -> Result<(), ContractError> {
    let current = TOTAL_REDEEMED.may_load(storage, wallet.clone())?.unwrap_or_default();
    TOTAL_REDEEMED.save(storage, wallet.clone(), &(current + amount))?;
    Ok(())
}
