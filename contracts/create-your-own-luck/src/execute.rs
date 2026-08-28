use cosmwasm_std::{
    from_json, to_json_binary, Addr, BankMsg, Coin, CosmosMsg, DepsMut, Empty, Env, HexBinary, MessageInfo, Order,
    Reply, Response, SubMsg, SubMsgResult, Timestamp, Uint128, WasmMsg,
};
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};
use sha2::{Digest, Sha256};

use crate::contract::{ANTI_SNIPE_EXTENSION_SECONDS, MAX_RAFFLE_AGE_SECONDS, MAX_REVEAL_AGE_SECONDS};
use crate::error::ContractError;
use crate::factory_msgs::{FactoryExecuteMsg, FactoryQueryMsg};
use crate::msg::Cw20HookMsg;
use crate::rand::pick_winner_index;
use crate::state::{
    Config, PrizeAsset, RaffleState, RaffleStatus, RaffleType, AIRDROP_CLAIMS, AIRDROP_CLAIM_IN_FLIGHT, CONFIG,
    NEXT_AIRDROP_CLAIM_REPLY_ID, PENDING_AIRDROP_CLAIMS, RAFFLE,
};

const FEE_SPLIT_BPS: u128 = 5000; // 50/50 founder/treasury, dust to treasury (see draw_winner)
const FEE_SPLIT_DENOM: u128 = 10000;

/// Reply id for a Cancel/ExpireRaffle prize-refund-to-creator `SubMsg` - see
/// `cancel_refund_messages`'s own doc comment for why this one is isolated
/// from the ticket/fee refunds (2026-08-20 audit fix).
const CANCEL_PRIZE_REFUND_REPLY_ID: u64 = 4;
/// Reply id for the `ReportCw20Failure` call to the factory, dispatched from
/// inside `handle_prize_transfer_failure` - a 2026-08-20 audit fix (2nd
/// round). Previously a plain `add_message`: if the factory ever rejected it
/// (an unrecognized caller, or simply unreachable), the failure would
/// propagate and revert the ENTIRE reply - including this handler's own
/// `RAFFLE.save` - reopening exactly the "prize-token state can abort an
/// unrelated transaction" class fix #7 (`PRIZE_TRANSFER_GAS_LIMIT`) closed
/// for the payout itself. Wrapped as `SubMsg::reply_on_error` instead, with
/// `handle_report_cw20_failure_reply` swallowing the error the same way
/// `handle_cancel_prize_refund_reply` already does.
const REPORT_CW20_FAILURE_REPLY_ID: u64 = 5;
/// Base reply id for a payout `SubMsg` dispatched by `DrawWinner`'s own
/// `perform_draw` call - the actual id is this plus the winner's index into
/// `RaffleState::winners` (`draw_payout_reply_id`), so `reply` can tell
/// which specific winner's transfer resolved without needing extra
/// pending-state storage. Safe without a pending map (unlike
/// `ClaimAirdropShare`, see `AIRDROP_CLAIM_REPLY_ID_BASE`'s own doc
/// comment): `DrawWinner` is creator-gated for its exclusive period, so a
/// reentrant prize-token callback can't call it back as anyone else, and
/// once permissionless, it can still only run once per raffle (`Closed` ->
/// `Drawn`), giving no window to double-dispatch the same index.
const DRAW_PAYOUT_REPLY_ID_BASE: u64 = 1000;
fn draw_payout_reply_id(winner_index: u32) -> u64 {
    DRAW_PAYOUT_REPLY_ID_BASE + winner_index as u64
}
/// Base reply id for a payout `SubMsg` re-dispatched by `RetryPrizePayout` -
/// same index-encoding as `draw_payout_reply_id`, but in its own numeric
/// range (offset far enough from `DRAW_PAYOUT_REPLY_ID_BASE` that neither
/// can ever collide with the other, given `MAX_PODIUM_PLACES` is a single-
/// digit cap) so `reply` can tell a retry-triggered failure apart from an
/// original-draw failure - see `PRIZE_TRANSFER_FAILURE_THRESHOLD`'s doc
/// comment for why that distinction matters (2026-08-20 audit fix, 2nd
/// round). Accepted, narrow residual risk, NOT fixed this round: unlike
/// `ClaimAirdropShare`, `RetryPrizePayout` is permissionless and its ids are
/// still fixed-by-index rather than counter-allocated, so a malicious CW20
/// prize could in principle reenter it mid-flight and double-dispatch the
/// same winner's transfer. Only reachable with a raffle's own prize token
/// deliberately built to do this, and that token is worthless by
/// construction (a real CW20 needs admin whitelist review for any PAID
/// raffle, and a free raffle's prize has no real-money claim on it) - the
/// same `attacker only ever controls a token they could already mint more
/// of directly, so there's no actual value to double-dispatching it`
/// reasoning already accepted elsewhere for this class of risk.
const RETRY_PAYOUT_REPLY_ID_BASE: u64 = 2000;
fn retry_payout_reply_id(winner_index: u32) -> u64 {
    RETRY_PAYOUT_REPLY_ID_BASE + winner_index as u64
}
/// Base reply id for a `ClaimAirdropShare` payout `SubMsg` (`ReplyOn::
/// Always` - see `prize_transfer_submsg`'s doc comment for why this needs to
/// hear back on success too, not just failure). Unlike the draw-payout ids
/// above, this is NOT a fixed offset - each dispatch gets its own, freshly
/// allocated id (`next_airdrop_claim_reply_id`, backed by
/// `NEXT_AIRDROP_CLAIM_REPLY_ID`), looked up in `PENDING_AIRDROP_CLAIMS` (a
/// `Map`, not a single `Item`) to recover which wallet it belongs to.
///
/// 2026-08-20 audit fix (2nd round, found independently by two reviewers):
/// the original design used one fixed id and a single-slot `Item` for "the
/// claimer currently in flight" - correct for the ordinary case (CosmWasm
/// resolves a dispatched SubMsg's reply before the next top-level message in
/// the same Response dispatches, so only one `ClaimAirdropShare` call is
/// ever "in flight" through NORMAL sequencing), but NOT under reentrancy: a
/// malicious CW20 prize token (unrestricted for a free raffle/Airdrop, no
/// whitelist required) can, inside its own `Transfer` handler, dispatch a
/// nested call back into this contract's `ClaimAirdropShare` - as itself, if
/// it also arranged to be a `unique_players` entrant. That nested call would
/// overwrite the single slot and then clear it via its own reply, so the
/// OUTER claim's reply would find the slot empty, error on `.load()`, and
/// revert the entire transaction - denying a real, innocent claimant their
/// prize, and doing so WITHOUT ever hitting `handle_prize_transfer_failure`
/// (the CW20 call itself reports `Ok`; the failure is purely in this
/// contract's own bookkeeping), so it silently evades the whole 3-strikes
/// detection/auto-blacklist mechanism too. A per-id map closes this
/// entirely: a nested claim gets its own id and its own map entry, so
/// resolving it can never clobber an outer, still-pending one.
/// Reply id for the `ConsumeCommit` `SubMsg` to the factory, dispatched from
/// `execute_deposit_prize`/`execute_receive` the moment the fee/prize is
/// funded (SingleWinner/Podium only). `SubMsg::reply_on_success`, not
/// `reply_always`: if the factory's queue is empty (or the call fails for
/// any other reason), the whole funding transaction reverts - the fee/prize
/// payment never actually leaves the creator's wallet, so there's nothing to
/// clean up, and they can simply retry once the admin restocks the queue.
const CONSUME_COMMIT_REPLY_ID: u64 = 20_000;
/// Width, in blocks, of the "second step" wait in the 3-phase expiration -
/// see wheel-manager's matching `EXPIRE_FINALIZE_DELAY_BLOCKS` for the full
/// rationale.
const EXPIRE_FINALIZE_DELAY_BLOCKS: u64 = 100;
/// Width, in blocks, of the "third step" wait - see wheel-manager's matching
/// `EXPIRE_CHALLENGE_BLOCKS`.
const EXPIRE_CHALLENGE_BLOCKS: u64 = 100;
/// See wheel-manager's matching `REQUEST_EXPIRE_TTL_BLOCKS`.
const REQUEST_EXPIRE_TTL_BLOCKS: u64 = 200;

const AIRDROP_CLAIM_REPLY_ID_BASE: u64 = 10_000;
fn next_airdrop_claim_reply_id(storage: &mut dyn cosmwasm_std::Storage) -> Result<u64, ContractError> {
    let next = NEXT_AIRDROP_CLAIM_REPLY_ID
        .may_load(storage)?
        .unwrap_or(AIRDROP_CLAIM_REPLY_ID_BASE);
    NEXT_AIRDROP_CLAIM_REPLY_ID.save(storage, &(next + 1))?;
    Ok(next)
}
/// Consecutive prize-transfer failures (against `Config::prize_asset`, which
/// is fixed per raffle - only one token can ever be involved) before this
/// raffle blocks further payout attempts and reports the token to the
/// factory's blacklist. See the finding this closes: a malicious CW20
/// prize whose `Transfer` reverts for anyone but the creator could, with
/// the OLD `add_message` (all-or-nothing) approach, let the whole
/// `DrawWinner` transaction revert and be retried indefinitely until the
/// hash happened to pick the creator's own wallet. Switching the transfer
/// to a `SubMsg` already closes that specific exploit outright - a failed
/// transfer no longer un-commits the winner selection, so there's no
/// "redo the draw" grinding loop left to exploit regardless of this
/// threshold. This counter's job is the secondary benefit: stop wasting gas
/// on further doomed attempts (`ClaimAirdropShare`, called once per
/// participant, is where several consecutive failures naturally accumulate
/// across separate transactions) and warn the platform's other raffles off
/// the same bad token.
///
/// 2026-08-20 audit fix (2nd round): a `RetryPrizePayout` failure does NOT
/// count toward this threshold (see `handle_draw_payout_reply`'s `count_
/// failure` parameter) - only an original `DrawWinner`/auto-close draw
/// attempt does. Without that distinction, adding `RetryPrizePayout` in the
/// FIRST audit-fix round (to close the fund-stranding finding) accidentally
/// reopened this exact griefing vector for SingleWinner too: before that
/// fix, SingleWinner only ever attempted its one payout ONCE per raffle
/// (structurally unreachable to hit 3 failures), but a permissionless,
/// unrate-limited retry loop made 3 CHEAP, attacker-chosen failures trivial
/// to manufacture against any prize token, permanently blacklisting it
/// platform-wide for the cost of a few retry transactions - confirmed
/// end-to-end by an independent reviewer re-testing this exact fix.
const PRIZE_TRANSFER_FAILURE_THRESHOLD: u32 = 3;

/// Shared tail of every payout: the creator's ticket revenue and the
/// founder/treasury fee split. Reused by both `resolve_airdrop` (called at
/// close time - Airdrop needs no preimage, see that function's own doc
/// comment) and `resolve_single_winner_or_podium` (called at reveal time) -
/// deliberately the SAME code, not a re-derived copy, so the Airdrop close
/// path can never silently drift from what `perform_draw` used to pay before
/// v9 (see the project's Obsidian notes on the Ronda 9 finding this closes:
/// an earlier v9 spec's Airdrop shortcut paid only `airdrop_share`, silently
/// dropping `ticket_revenue`/`fee_amount` - real, permanent fund loss).
fn dispatch_ticket_revenue_and_fee_payouts(config: &Config, raffle: &RaffleState) -> Vec<SubMsg> {
    let mut messages: Vec<SubMsg> = vec![];

    if !raffle.ticket_revenue.is_zero() {
        messages.push(SubMsg::new(CosmosMsg::from(BankMsg::Send {
            to_address: config.creator.to_string(),
            amount: vec![Coin {
                denom: config.ticket_denom.clone(),
                amount: raffle.ticket_revenue,
            }],
        })));
    }

    if !raffle.fee_amount.is_zero() {
        let founder_cut = raffle.fee_amount.multiply_ratio(FEE_SPLIT_BPS, FEE_SPLIT_DENOM);
        let treasury_cut = raffle.fee_amount.checked_sub(founder_cut).unwrap_or_default();

        for (addr, amount) in [
            (&config.founder_fee_address, founder_cut),
            (&config.treasury_address, treasury_cut),
        ] {
            if !amount.is_zero() {
                messages.push(SubMsg::new(CosmosMsg::from(BankMsg::Send {
                    to_address: addr.to_string(),
                    amount: vec![Coin {
                        denom: config.usdc_denom.clone(),
                        amount,
                    }],
                })));
            }
        }
    }

    messages
}

/// Airdrop only, called from `execute_close_round`/the sold-out branch of
/// `execute_buy_ticket` - never needs a preimage (the split is a pure
/// deterministic function of `prize_amount`/`unique_players`, no draw), so it
/// resolves immediately at close instead of waiting for a separate
/// `RevealDraw` the way SingleWinner/Podium now must. This is also why
/// Airdrop never consumes a commit (see `execute_deposit_prize`/
/// `execute_receive`) and never reaches `RaffleStatus::Closed` at all -
/// straight from `Open` to `Drawn` in the same transaction that closes it.
fn resolve_airdrop(config: &Config, raffle: &mut RaffleState, time: Timestamp) -> Vec<SubMsg> {
    raffle.airdrop_share = raffle
        .prize_amount
        .multiply_ratio(1u128, raffle.unique_players.len() as u128);
    let messages = dispatch_ticket_revenue_and_fee_payouts(config, raffle);
    raffle.status = RaffleStatus::Drawn;
    raffle.drawn_at = Some(time);
    messages
}

/// SingleWinner/Podium only, called from `execute_reveal_draw` once the
/// `preimage` has already been verified against `commit_used`. Same
/// winner-selection shape as the pre-v9 `perform_draw` (Podium's `pool.retain`
/// loop, dust rounding into the first place), with `preimage` (not block
/// data) as the entropy source - see `rand::pick_winner_index`'s doc comment.
fn resolve_single_winner_or_podium(
    contract_addr: &Addr,
    config: &Config,
    raffle: &mut RaffleState,
    preimage: &[u8],
    time: Timestamp,
) -> Vec<SubMsg> {
    let mut messages: Vec<SubMsg> = vec![];

    match config.raffle_type {
        RaffleType::SingleWinner => {
            let idx = pick_winner_index(contract_addr, preimage, 0, &raffle.entrants);
            let winner = raffle.entrants[idx].clone();
            raffle.winners = vec![winner.clone()];
            raffle.prize_shares = vec![raffle.prize_amount];
            // A zero prize_amount shouldn't be reachable in practice
            // (DepositPrize/execute_receive both reject a zero deposit), but
            // guarded the same way Podium's own shares already were, for the
            // same reason: never dispatch a doomed zero-amount transfer (see
            // `PRIZE_TRANSFER_FAILURE_THRESHOLD`'s sibling finding - a
            // zero-amount CW20 transfer is rejected by the standard itself,
            // which would otherwise count as a real "failure" toward the
            // auto-blacklist threshold for nothing).
            raffle.prize_paid = vec![raffle.prize_amount.is_zero()];
            if !raffle.prize_amount.is_zero() {
                messages.push(prize_transfer_submsg(
                    &config.prize_asset,
                    &winner,
                    raffle.prize_amount,
                    draw_payout_reply_id(0),
                ));
            }
        }
        RaffleType::Podium => {
            let mut winners: Vec<Addr> = vec![];
            let mut pool = raffle.entrants.clone();
            for place in 0..config.podium_shares_bps.len() as u64 {
                let idx = pick_winner_index(contract_addr, preimage, place, &pool);
                let winner = pool[idx].clone();
                winners.push(winner.clone());
                pool.retain(|e| *e != winner);
            }

            const PODIUM_DENOM: u128 = 10_000;
            let allocated: Uint128 = config
                .podium_shares_bps
                .iter()
                .map(|bps| raffle.prize_amount.multiply_ratio(*bps as u128, PODIUM_DENOM))
                .sum();
            let mut shares: Vec<Uint128> = config
                .podium_shares_bps
                .iter()
                .map(|bps| raffle.prize_amount.multiply_ratio(*bps as u128, PODIUM_DENOM))
                .collect();
            shares[0] += raffle.prize_amount.checked_sub(allocated).unwrap_or_default();

            let mut prize_paid: Vec<bool> = vec![];
            for (i, (winner, share)) in winners.iter().zip(shares.iter()).enumerate() {
                if !share.is_zero() {
                    messages.push(prize_transfer_submsg(
                        &config.prize_asset,
                        winner,
                        *share,
                        draw_payout_reply_id(i as u32),
                    ));
                    prize_paid.push(false);
                } else {
                    prize_paid.push(true);
                }
            }
            raffle.winners = winners;
            raffle.prize_shares = shares;
            raffle.prize_paid = prize_paid;
        }
        RaffleType::Airdrop => unreachable!("resolve_single_winner_or_podium is never called for Airdrop"),
    }

    messages.extend(dispatch_ticket_revenue_and_fee_payouts(config, raffle));

    raffle.status = RaffleStatus::Drawn;
    raffle.drawn_at = Some(time);

    messages
}

/// Rejects any attached coin whose denom isn't in `allowed` - otherwise an
/// unrelated coin sent by mistake (wrong wallet UI, fat-fingered denom) would
/// be silently absorbed by the contract with no sweep mechanism to recover it.
fn reject_unexpected_funds(funds: &[Coin], allowed: &[&str]) -> Result<(), ContractError> {
    for coin in funds {
        if !allowed.contains(&coin.denom.as_str()) {
            return Err(ContractError::UnexpectedFundsAttached {
                denom: coin.denom.clone(),
            });
        }
    }
    Ok(())
}

fn prize_transfer_msg(prize_asset: &PrizeAsset, recipient: &Addr, amount: Uint128) -> CosmosMsg {
    match prize_asset {
        PrizeAsset::Native { denom } => BankMsg::Send {
            to_address: recipient.to_string(),
            amount: vec![Coin {
                denom: denom.clone(),
                amount,
            }],
        }
        .into(),
        PrizeAsset::Cw20 { address } => WasmMsg::Execute {
            contract_addr: address.to_string(),
            msg: cosmwasm_std::to_json_binary(&Cw20ExecuteMsg::Transfer {
                recipient: recipient.to_string(),
                amount,
            })
            .expect("Cw20ExecuteMsg::Transfer always serializes"),
            funds: vec![],
        }
        .into(),
    }
}

/// Gas ceiling on a dispatched prize-transfer `SubMsg` - without this, a
/// CW20 `Transfer` written to burn all remaining gas instead of returning a
/// clean error would still abort the whole transaction (out-of-gas isn't
/// something `reply` can catch), reopening the exact "revert until the hash
/// favors me" loop the `SubMsg` conversion below was meant to close (found
/// in the 2026-08-20 audit). A real CW20 `Transfer` costs a few hundred
/// thousand gas at most (balance read/write, maybe a hook call or two) -
/// this leaves generous headroom while still bounding the worst case.
const PRIZE_TRANSFER_GAS_LIMIT: u64 = 1_000_000;

/// Wraps `prize_transfer_msg` as a `SubMsg` with `ReplyOn::Always` instead of
/// a plain `add_message` - used ONLY where the recipient could be a real
/// third party the creator doesn't control (a drawn winner, an airdrop
/// claimer). A malicious CW20 whose `Transfer` reverts for anyone but the
/// creator can no longer un-commit the winner selection by reverting the
/// whole transaction (the old `add_message` behavior) - the outcome is
/// caught here instead, on both branches: success finalizes the payout
/// (`handle_draw_payout_reply`/`handle_airdrop_claim_reply` mark it paid/
/// claimed only now, not before dispatch - a 2026-08-20 audit fix, see
/// their own doc comments for the fund-stranding bug this closes), failure
/// runs `handle_prize_transfer_failure`. NOT used for `ReclaimUnclaimed`'s
/// prize-to-creator transfer, or `CancelRaffle`/`ExpireRaffle`'s ticket/fee
/// refunds - those always pay a wallet with no incentive (or, for
/// `ReclaimUnclaimed`, no ability) to grind the draw outcome, so the
/// exploit this defends against doesn't apply. `CancelRaffle`/
/// `ExpireRaffle`'s own prize-to-creator refund gets a narrower, separate
/// `SubMsg` (`cancel_refund_messages`) for a different reason - see its own
/// doc comment.
fn prize_transfer_submsg(prize_asset: &PrizeAsset, recipient: &Addr, amount: Uint128, reply_id: u64) -> SubMsg {
    SubMsg::reply_always(prize_transfer_msg(prize_asset, recipient, amount), reply_id)
        .with_gas_limit(PRIZE_TRANSFER_GAS_LIMIT)
}

/// Catches a failed prize-transfer `SubMsg` (see `prize_transfer_submsg`)
/// instead of letting it revert the whole transaction - closes the "CW20
/// malicious prize selectively blocks the draw" finding (cataloged
/// 2026-08-10): with the old all-or-nothing `add_message` behavior, a CW20
/// whose `Transfer` reverts for anyone but the creator would revert the
/// *entire* DrawWinner transaction whenever a real participant was picked,
/// letting the creator retry indefinitely until the hash happened to favor
/// them. Switching to a `SubMsg` already closes that outright - the winner
/// selection commits regardless of whether the transfer itself succeeds, so
/// there's no "undo and try again" loop left. This handler's job is the
/// secondary part of the 2026-08-20 design: count consecutive failures
/// (there's only ever one prize token per raffle, so every failure here is
/// against the same one - genuinely consecutive since the success path
/// resets this counter, see the callers) and, at the 3rd in a row,
/// permanently block further payout attempts on this raffle and report the
/// token to the factory's blacklist (`ReportCw20Failure`) - fully on-chain,
/// no off-chain bot, since the factory only accepts that call from a raffle
/// address it itself deployed.
/// `count_failure` (2026-08-20 audit fix, 2nd round): whether this failure
/// should count toward `PRIZE_TRANSFER_FAILURE_THRESHOLD` - `true` for an
/// original `DrawWinner`/auto-close draw attempt, `false` for a
/// `RetryPrizePayout` re-attempt (or the airdrop-claim path, which
/// always passes `true` - retries there don't exist, a claimant just calls
/// `ClaimAirdropShare` again). See `PRIZE_TRANSFER_FAILURE_THRESHOLD`'s own
/// doc comment for why permissionless retries must NOT count: otherwise
/// they'd turn the 3-strikes auto-blacklist into a griefing tool anyone can
/// trigger cheaply against any token.
fn handle_prize_transfer_failure(deps: DepsMut, count_failure: bool) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    // A native BankMsg::Send failure was never meant to count (see
    // RaffleState::prize_transfer_failures's own doc comment) - but nothing
    // actually enforced that until this line (2026-08-20 audit fix, round
    // 4). In practice a valid-address native send doesn't fail, but if one
    // somehow did, counting it toward the threshold would set prize_blocked
    // with no way back: maybe_clear_prize_blocked only ever checks the CW20
    // blacklist, so a Native raffle has no path to clear it, and none of
    // Cancel/Expire/Reclaim accept a Drawn raffle - the prize would be stuck
    // forever, for a threshold this asset type was never supposed to reach.
    let is_native = matches!(config.prize_asset, PrizeAsset::Native { .. });
    if !count_failure || is_native {
        return Ok(Response::new()
            .add_attribute("action", "prize_transfer_failed")
            .add_attribute("counted", "false"));
    }

    raffle.prize_transfer_failures += 1;
    let mut response = Response::new()
        .add_attribute("action", "prize_transfer_failed")
        .add_attribute("failure_count", raffle.prize_transfer_failures.to_string());

    if raffle.prize_transfer_failures >= PRIZE_TRANSFER_FAILURE_THRESHOLD {
        raffle.prize_blocked = true;
        response = response.add_attribute("prize_blocked", "true");
        if let PrizeAsset::Cw20 { address } = &config.prize_asset {
            response = response.add_submessage(SubMsg::reply_on_error(
                WasmMsg::Execute {
                    contract_addr: config.factory_address.to_string(),
                    msg: to_json_binary(&FactoryExecuteMsg::ReportCw20Failure { address: address.to_string() })?,
                    funds: vec![],
                },
                REPORT_CW20_FAILURE_REPLY_ID,
            ));
        }
    }

    RAFFLE.save(deps.storage, &raffle)?;
    Ok(response)
}

/// Finalizes a `DrawWinner`/`RetryPrizePayout` payout `SubMsg` (see
/// `draw_payout_reply_id`/`retry_payout_reply_id`) - marks that specific
/// winner's share paid on success (and resets the consecutive-failure
/// counter), or runs the shared failure handling on error (only counted
/// toward the threshold when `count_failure` is true - see its own doc
/// comment). 2026-08-20 audit fix: previously the payout used `ReplyOn::
/// Error` and the winner was already considered "done" the instant
/// `DrawWinner` returned, regardless of whether the transfer actually
/// succeeded - a SingleWinner/Podium prize that failed to pay out had no
/// recovery path at all.
fn handle_draw_payout_reply(
    deps: DepsMut,
    winner_index: u32,
    result: SubMsgResult,
    count_failure: bool,
) -> Result<Response, ContractError> {
    match result {
        SubMsgResult::Ok(_) => {
            let mut raffle = RAFFLE.load(deps.storage)?;
            if let Some(paid) = raffle.prize_paid.get_mut(winner_index as usize) {
                *paid = true;
            }
            raffle.prize_transfer_failures = 0;
            RAFFLE.save(deps.storage, &raffle)?;
            Ok(Response::new()
                .add_attribute("action", "prize_transfer_succeeded")
                .add_attribute("winner_index", winner_index.to_string()))
        }
        SubMsgResult::Err(_) => handle_prize_transfer_failure(deps, count_failure),
    }
}

/// Finalizes a `ClaimAirdropShare` payout `SubMsg` - marks `AIRDROP_CLAIMS`
/// `true` (and resets the consecutive-failure counter) only once the
/// transfer is confirmed, using `PENDING_AIRDROP_CLAIMS[reply_id]` to
/// recover which wallet this specific reply belongs to (removed either way,
/// success or failure, once resolved). 2026-08-20 audit fix: previously
/// `AIRDROP_CLAIMS` was set `true` before the transfer was even dispatched,
/// so an honest failure (not just a malicious one) permanently marked a
/// claimant as paid without ever paying them - `AlreadyClaimed` blocked any
/// retry, and `ReclaimUnclaimed` treated the share as already handled
/// instead of sweeping it back to the creator. `reply_id` (not a fixed
/// constant) is itself a 2nd-round audit fix - see `AIRDROP_CLAIM_REPLY_ID_
/// BASE`'s own doc comment for the reentrancy gap a single shared id/slot
/// had. Also clears `AIRDROP_CLAIM_IN_FLIGHT` for the claimer on both
/// branches (2026-08-20 audit fix, round 4) - see that map's own doc comment
/// for the double-dispatch gap this closes.
fn handle_airdrop_claim_reply(deps: DepsMut, reply_id: u64, result: SubMsgResult) -> Result<Response, ContractError> {
    let claimer = PENDING_AIRDROP_CLAIMS.load(deps.storage, reply_id)?;
    PENDING_AIRDROP_CLAIMS.remove(deps.storage, reply_id);
    AIRDROP_CLAIM_IN_FLIGHT.remove(deps.storage, claimer.clone());
    match result {
        SubMsgResult::Ok(_) => {
            AIRDROP_CLAIMS.save(deps.storage, claimer.clone(), &true)?;
            let mut raffle = RAFFLE.load(deps.storage)?;
            raffle.prize_transfer_failures = 0;
            RAFFLE.save(deps.storage, &raffle)?;
            Ok(Response::new()
                .add_attribute("action", "airdrop_claim_succeeded")
                .add_attribute("claimer", claimer))
        }
        SubMsgResult::Err(_) => handle_prize_transfer_failure(deps, true),
    }
}

/// Swallows a failed Cancel/ExpireRaffle prize-refund-to-creator transfer
/// instead of letting it revert the whole transaction - see
/// `cancel_refund_messages`'s own doc comment for why this one is isolated
/// rather than sharing `handle_prize_transfer_failure`'s counter/blacklist
/// logic (the recipient here is always the creator's own wallet, not a
/// third party, so there's no grinding exploit to track).
fn handle_cancel_prize_refund_reply(result: SubMsgResult) -> Result<Response, ContractError> {
    match result {
        SubMsgResult::Ok(_) => Ok(Response::new()),
        SubMsgResult::Err(_) => Ok(Response::new().add_attribute("cancel_prize_refund_failed", "true")),
    }
}

/// Swallows a failed `ReportCw20Failure` call to the factory instead of
/// letting it revert the whole transaction - see `REPORT_CW20_FAILURE_
/// REPLY_ID`'s own doc comment (2026-08-20 audit fix, 2nd round).
fn handle_report_cw20_failure_reply(result: SubMsgResult) -> Result<Response, ContractError> {
    match result {
        SubMsgResult::Ok(_) => Ok(Response::new()),
        SubMsgResult::Err(_) => Ok(Response::new().add_attribute("report_cw20_failure_failed", "true")),
    }
}

/// Finalizes the `ConsumeCommit` `SubMsg` dispatched by `execute_deposit_prize`/
/// `execute_receive` - reads the commit back from the factory's reply `data`
/// and transitions `AwaitingCommit -> Open`. Only reachable on success
/// (`SubMsg::reply_on_success` - see `CONSUME_COMMIT_REPLY_ID`'s own doc
/// comment for why a failure here instead reverts the whole funding
/// transaction, with nothing to finalize).
///
/// With `cosmwasm-std = "1.5.4"`, a `WasmMsg::Execute` reply's `data` is the
/// protobuf-encoded `MsgExecuteContractResponse`, not the callee's
/// `Response.data` verbatim - `cw_utils::parse_reply_execute_data` unwraps
/// that layer (same pattern the factory's own `reply` handler already uses
/// for its instantiate replies, via `parse_reply_instantiate_data`).
fn handle_consume_commit_reply(deps: DepsMut, msg: Reply) -> Result<Response, ContractError> {
    let response = cw_utils::parse_reply_execute_data(msg).map_err(|_| ContractError::NoCommitInReply {})?;
    let data = response.data.ok_or(ContractError::NoCommitInReply {})?;
    let commit: HexBinary = from_json(&data)?;

    let mut raffle = RAFFLE.load(deps.storage)?;
    raffle.commit_used = Some(commit);
    raffle.status = RaffleStatus::Open;
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_attribute("action", "consume_commit"))
}

pub fn reply(deps: DepsMut, msg: Reply) -> Result<Response, ContractError> {
    match msg.id {
        CANCEL_PRIZE_REFUND_REPLY_ID => handle_cancel_prize_refund_reply(msg.result),
        REPORT_CW20_FAILURE_REPLY_ID => handle_report_cw20_failure_reply(msg.result),
        CONSUME_COMMIT_REPLY_ID => handle_consume_commit_reply(deps, msg),
        id if id >= AIRDROP_CLAIM_REPLY_ID_BASE => handle_airdrop_claim_reply(deps, id, msg.result),
        id if id >= RETRY_PAYOUT_REPLY_ID_BASE => {
            let winner_index = (id - RETRY_PAYOUT_REPLY_ID_BASE) as u32;
            handle_draw_payout_reply(deps, winner_index, msg.result, false)
        }
        id if id >= DRAW_PAYOUT_REPLY_ID_BASE => {
            let winner_index = (id - DRAW_PAYOUT_REPLY_ID_BASE) as u32;
            handle_draw_payout_reply(deps, winner_index, msg.result, true)
        }
        id => Err(ContractError::UnknownReplyId { id }),
    }
}

/// Re-checks the factory's live CW20 blacklist status and clears this
/// raffle's own `prize_blocked` flag (and resets the failure counter) if the
/// admin has since called `UnblacklistCw20` there - 2026-08-20 audit fix.
/// Previously `prize_blocked` never healed even after the admin corrected a
/// wrongly-blacklisted token: this raffle's local flag was set once and
/// stayed set forever, regardless of what the factory's blacklist said
/// later. A no-op for a native prize (no blacklist ever applies) or when
/// `prize_blocked` isn't currently set.
fn maybe_clear_prize_blocked(deps: &DepsMut, config: &Config, raffle: &mut RaffleState) -> Result<(), ContractError> {
    if !raffle.prize_blocked {
        return Ok(());
    }
    if let PrizeAsset::Cw20 { address } = &config.prize_asset {
        let still_blacklisted: bool = deps.querier.query_wasm_smart(
            &config.factory_address,
            &FactoryQueryMsg::IsCw20Blacklisted { address: address.to_string() },
        )?;
        if !still_blacklisted {
            raffle.prize_blocked = false;
            raffle.prize_transfer_failures = 0;
        }
    }
    Ok(())
}

/// Holds the fixed USDC service fee, refunding any overpayment. Shared by
/// `PayServiceFee` and the native `DepositPrize` convenience path.
fn collect_service_fee(config: &crate::state::Config, sent_usdc: Uint128) -> Result<(Uint128, Uint128), ContractError> {
    let required_usdc = config.fee_amount_usdc;
    if sent_usdc < required_usdc {
        return Err(ContractError::WrongFeePayment {
            expected: required_usdc,
            denom: config.usdc_denom.clone(),
        });
    }
    let refund = sent_usdc - required_usdc;
    Ok((required_usdc, refund))
}

pub fn execute_pay_service_fee(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if raffle.status != RaffleStatus::Funding {
        return Err(ContractError::AlreadyFunded {});
    }
    if raffle.fee_paid {
        return Err(ContractError::AlreadyFunded {});
    }

    reject_unexpected_funds(&info.funds, &[&config.usdc_denom])?;
    let sent_usdc = info
        .funds
        .iter()
        .find(|c| c.denom == config.usdc_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    let (required_usdc, refund) = collect_service_fee(&config, sent_usdc)?;

    raffle.fee_amount = required_usdc;
    raffle.fee_paid = true;
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: config.usdc_denom,
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "pay_service_fee")
        .add_attribute("fee_amount", required_usdc.to_string()))
}

pub fn execute_deposit_prize(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    let native_denom = match &config.prize_asset {
        PrizeAsset::Native { denom } => denom.clone(),
        PrizeAsset::Cw20 { .. } => return Err(ContractError::PrizeIsCw20 {}),
    };

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if raffle.status != RaffleStatus::Funding {
        return Err(ContractError::AlreadyFunded {});
    }

    if raffle.fee_paid {
        reject_unexpected_funds(&info.funds, &[&native_denom])?;
    } else {
        reject_unexpected_funds(&info.funds, &[&native_denom, &config.usdc_denom])?;
    }

    let prize_sent = info
        .funds
        .iter()
        .find(|c| c.denom == native_denom)
        .map(|c| c.amount)
        .unwrap_or_default();
    if prize_sent.is_zero() {
        return Err(ContractError::ZeroPrize {});
    }
    // No on-chain "worst-case share >= ticket price" fairness floor here on
    // purpose (2026-08-21 audit round, reverses a 2026-08-20 on-chain block
    // that turned out unsound) - see this same guard's removal in
    // `execute_receive` below for the full reasoning; a native prize can be
    // LUNC/USDC/USTC, three assets with very different real value per unit,
    // and comparing their raw micros against `ticket_price` (always USDC)
    // has no relationship to real fairness without a price oracle, which
    // this project has twice already rejected building (see `USDC_DENOM`'s
    // own doc comment history and the CYOL service-fee redesign that
    // dropped its own pool-based oracle for the same reason). Mitigated
    // instead the same way as every other creator-fairness finding in this
    // contract (self-dealing, late cancellation): a frontend warning +
    // mandatory checkbox at fund time, plus the creator's wallet being
    // public on every raffle listing - disclosure and reputation, not a
    // contract-level block that would either be wrong (LUNC/USTC) or would
    // foreclose whitelisted-CW20 prizes entirely (no reliable value signal
    // for those either without an oracle).

    let mut messages: Vec<CosmosMsg> = vec![];

    if raffle.fee_paid {
        // Fee was already settled via a separate `PayServiceFee` call (this is
        // required, not just allowed, when the prize denom is the same as the
        // USDC fee denom - see `MustPayServiceFeeSeparately` below).
    } else {
        if native_denom == config.usdc_denom {
            return Err(ContractError::MustPayServiceFeeSeparately {});
        }
        let sent_usdc = info
            .funds
            .iter()
            .find(|c| c.denom == config.usdc_denom)
            .map(|c| c.amount)
            .unwrap_or_default();
        let (required_usdc, refund) = collect_service_fee(&config, sent_usdc)?;
        raffle.fee_amount = required_usdc;
        raffle.fee_paid = true;
        if !refund.is_zero() {
            messages.push(
                BankMsg::Send {
                    to_address: info.sender.to_string(),
                    amount: vec![Coin {
                        denom: config.usdc_denom.clone(),
                        amount: refund,
                    }],
                }
                .into(),
            );
        }
    }

    raffle.prize_amount = prize_sent;
    raffle.opened_at = Some(env.block.time);

    if config.raffle_type == RaffleType::Airdrop {
        // Airdrop never needs a commit - no draw, deterministic split. Goes
        // straight to Open, exactly as before v9 (see
        // `resolve_airdrop`/`execute_close_round`'s doc comments for the
        // rest of its lifecycle). Applied here AND in `execute_receive`
        // below (the CW20 path) - both are independent Funding->Open entry
        // points, and both need this same bifurcation (Ronda 9 finding,
        // confirmed by both auditors independently: a version that only
        // bifurcated one of the two would leave the other type of Airdrop
        // prize forced through ConsumeCommit for nothing).
        raffle.status = RaffleStatus::Open;
        RAFFLE.save(deps.storage, &raffle)?;
        return Ok(Response::new()
            .add_messages(messages)
            .add_attribute("action", "deposit_prize")
            .add_attribute("prize_amount", prize_sent.to_string())
            .add_attribute("fee_amount", raffle.fee_amount.to_string()));
    }

    raffle.status = RaffleStatus::AwaitingCommit;
    RAFFLE.save(deps.storage, &raffle)?;
    let consume_commit = SubMsg::reply_on_success(
        WasmMsg::Execute {
            contract_addr: config.factory_address.to_string(),
            msg: to_json_binary(&FactoryExecuteMsg::ConsumeCommit {})?,
            funds: vec![],
        },
        CONSUME_COMMIT_REPLY_ID,
    );

    Ok(Response::new()
        .add_messages(messages)
        .add_submessage(consume_commit)
        .add_attribute("action", "deposit_prize")
        .add_attribute("prize_amount", prize_sent.to_string())
        .add_attribute("fee_amount", raffle.fee_amount.to_string()))
}

pub fn execute_receive(deps: DepsMut, env: Env, info: MessageInfo, wrapper: Cw20ReceiveMsg) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    let cw20_address = match &config.prize_asset {
        PrizeAsset::Cw20 { address } => address.clone(),
        PrizeAsset::Native { .. } => return Err(ContractError::PrizeIsNative {}),
    };
    // The CW20 contract itself is `info.sender` for a `Receive` callback; the
    // wallet that actually triggered the `Send` is `wrapper.sender`.
    if info.sender != cw20_address {
        return Err(ContractError::Unauthorized {});
    }
    let original_sender = deps.api.addr_validate(&wrapper.sender)?;
    if original_sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if raffle.status != RaffleStatus::Funding {
        return Err(ContractError::AlreadyFunded {});
    }
    if !raffle.fee_paid {
        return Err(ContractError::MustPayServiceFeeSeparately {});
    }
    if wrapper.amount.is_zero() {
        return Err(ContractError::ZeroPrize {});
    }

    // Re-checked live here, not just once at instantiate (2026-08-20 design)
    // - closes the narrow race window where this token gets blacklisted (or
    // de-whitelisted, for a paid raffle) in the time between this raffle's
    // own instantiate and the creator actually depositing it. If this
    // rejects, the creator is left in `Funding` with the fee already paid -
    // `CancelRaffle` from there is exempt from the cancellation penalty for
    // exactly this case (see `cancellation_penalty_waived_by_platform_revocation`).
    let blacklisted: bool = deps.querier.query_wasm_smart(
        &config.factory_address,
        &FactoryQueryMsg::IsCw20Blacklisted { address: cw20_address.to_string() },
    )?;
    if blacklisted {
        return Err(ContractError::PrizeAssetBlacklisted {});
    }
    if !config.ticket_price.is_zero() {
        let whitelisted: bool = deps.querier.query_wasm_smart(
            &config.factory_address,
            &FactoryQueryMsg::IsCw20Whitelisted { address: cw20_address.to_string() },
        )?;
        if !whitelisted {
            return Err(ContractError::PrizeAssetNotAllowlisted {});
        }
    }
    // No on-chain "worst-case share >= ticket price" fairness floor here on
    // purpose (2026-08-21 audit round, reverses a 2026-08-20 on-chain
    // block). The check that used to sit here (`reject_unfair_paid_airdrop_
    // funding`, since deleted) compared `prize_amount`'s raw micros against
    // `ticket_price * max_players` (always USDC micros) with no price
    // conversion and no denom-equality requirement - mathematically sound
    // only when the prize is USDC itself, silently wrong for a native LUNC/
    // USTC prize (both worth a small fraction of $1 per unit, so the raw
    // check is far too permissive) and for any whitelisted CW20 prize (no
    // price signal at all, arbitrary decimals). USTC (`uusd`) is already a
    // real, distinct denom on this very testnet, so this wasn't a purely
    // theoretical post-mainnet gap - found in round 6 of this project's
    // repeated Opus+Fable+Nemotron audit passes on this contract. No fix is
    // possible on-chain without a price oracle, which this project has
    // twice already deliberately rejected building (manipulable without a
    // TWAP; see `USDC_DENOM`'s own doc comment history and the CYOL
    // service-fee redesign that dropped its own pool-based oracle for the
    // same reason) - and even a proper TWAP oracle wouldn't cover a
    // brand-new whitelisted CW20 with no liquid market yet, which is
    // exactly the case this platform most wants to enable (a community
    // project rewarding paid-ticket supporters with its own token instead
    // of the creator's own USDC). Explicit product decision: worth less
    // than the ticket in the worst case extracts value from the community
    // for nothing (a paid raffle - SingleWinner/Podium - is the right tool
    // for genuine crowdfunding, where that mismatch is normal lottery
    // mechanics) - mitigated the same way as this contract's other
    // creator-fairness findings (self-dealing, late cancellation):
    // disclosure + reputation (frontend warning + mandatory checkbox at
    // fund time, creator's wallet public on every raffle listing), not a
    // contract-level block that's either mathematically wrong or forecloses
    // the whitelisted-CW20-reward use case entirely.

    match from_json::<Cw20HookMsg>(&wrapper.msg)? {
        Cw20HookMsg::DepositPrize {} => {
            raffle.prize_amount = wrapper.amount;
            raffle.opened_at = Some(env.block.time);

            // Same bifurcation as execute_deposit_prize's native path - see
            // its own doc comment for why Airdrop is exempt and why both
            // entry points need this applied independently.
            if config.raffle_type == RaffleType::Airdrop {
                raffle.status = RaffleStatus::Open;
                RAFFLE.save(deps.storage, &raffle)?;
                return Ok(Response::new()
                    .add_attribute("action", "deposit_prize")
                    .add_attribute("prize_amount", wrapper.amount.to_string())
                    .add_attribute("fee_amount", raffle.fee_amount.to_string()));
            }

            raffle.status = RaffleStatus::AwaitingCommit;
            RAFFLE.save(deps.storage, &raffle)?;
            let consume_commit = SubMsg::reply_on_success(
                WasmMsg::Execute {
                    contract_addr: config.factory_address.to_string(),
                    msg: to_json_binary(&FactoryExecuteMsg::ConsumeCommit {})?,
                    funds: vec![],
                },
                CONSUME_COMMIT_REPLY_ID,
            );

            Ok(Response::new()
                .add_submessage(consume_commit)
                .add_attribute("action", "deposit_prize")
                .add_attribute("prize_amount", wrapper.amount.to_string())
                .add_attribute("fee_amount", raffle.fee_amount.to_string()))
        }
    }
}

/// Bounds how many tickets a single wallet may hold. For SingleWinner/Podium
/// *paid* raffles, no more than half of `max_players` worth - bounds the
/// worst-case size of `entrants` (so `DrawWinner`'s winner-picking hash can
/// never grow unbounded) while still leaving room for the weighted-odds "buy
/// more, better chances" feature - buying more tickets costs real money, so
/// it's an ordinary lottery trade-off.
///
/// Free raffles (`ticket_price` zero) are capped at exactly 1 per wallet
/// regardless of type (2026-07-21): with nothing to lose by calling
/// `BuyTicket` again, a single wallet could otherwise grab up to half of
/// `max_players`' worth of entries for free, dominating a raffle meant to
/// give the community an even chance. Airdrop is always 1 per wallet anyway
/// (CodeRabbit review, 2026-07-15: at the top fee tier, the SingleWinner/
/// Podium formula would allow up to 500 tickets/wallet, so `entrants` could
/// reach 500,000 - and `CancelRaffle` scans `unique_players x entrants`
/// refunding everyone in a single transaction, which could exceed block gas
/// and strand the raffle `Closed` forever; Airdrop splits equally per unique
/// player anyway, so extra tickets per wallet buy nothing).
pub fn max_tickets_per_wallet(raffle_type: RaffleType, max_players: u32, ticket_price: Uint128) -> u32 {
    if ticket_price.is_zero() {
        return 1;
    }
    match raffle_type {
        RaffleType::Airdrop => 1,
        RaffleType::SingleWinner | RaffleType::Podium => std::cmp::max(1, max_players / 2),
    }
}

pub fn execute_buy_ticket(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }
    if let Some(allowlist) = &config.allowed_entrants {
        if !allowlist.contains(&info.sender) {
            return Err(ContractError::NotAllowed {});
        }
    }

    let cap = max_tickets_per_wallet(config.raffle_type, config.max_players, config.ticket_price);
    let already_bought = raffle.entrants.iter().filter(|e| **e == info.sender).count() as u32;
    if already_bought >= cap {
        return Err(ContractError::TicketCapExceeded { max_per_wallet: cap });
    }

    // Unlike DepositPrize/PayServiceFee, this used to accept any attached
    // funds silently: only `ticket_denom` was ever inspected, so a second,
    // unrelated coin riding along on the same call (a cloned/phishing
    // frontend, a raw contract call, or a stale-price frontend bug) would be
    // absorbed with no refund and no record - the "free raffle carries no
    // financial risk" reasoning behind skipping the prize allowlist above
    // depends on BuyTicket genuinely costing nothing when ticket_price is 0.
    if config.ticket_price.is_zero() {
        reject_unexpected_funds(&info.funds, &[])?;
    } else {
        reject_unexpected_funds(&info.funds, &[&config.ticket_denom])?;
    }

    if !config.ticket_price.is_zero() {
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
        raffle.ticket_revenue += sent_amount;
    }

    raffle.entrants.push(info.sender.clone());
    if !raffle.unique_players.contains(&info.sender) {
        raffle.unique_players.push(info.sender.clone());
    }

    // Soft-close deadline (2026-08-20 design): set exactly once, the first
    // time min_players is reached - never fully reset on a later purchase
    // (the naive "reset the whole window" approach considered and rejected
    // during design: a couple of well-timed late purchases could stretch a
    // raffle the creator intended to close around day 20 all the way out to
    // the 60-day hard cap). A purchase landing in the final
    // ANTI_SNIPE_EXTENSION_SECONDS before the current deadline pushes it out
    // by exactly that much instead, capped at MAX_RAFFLE_AGE_SECONDS from
    // `opened_at` regardless of how many extensions accumulate.
    if raffle.unique_players.len() as u32 >= config.min_players {
        // Both branches below are clamped against the same 60-day hard cap
        // from `opened_at` - a 2026-08-20 audit fix. The original code only
        // ever consulted `hard_cap` inside the extension branch, so (a) the
        // INITIAL deadline (set the first time `min_players` is reached) had
        // no clamp at all - a creator-chosen 31-day window reached late
        // could land past the 60-day cap it was supposed to be bounded by -
        // and (b) `min(extended, hard_cap)` alone, once already past
        // `hard_cap`, could move the deadline BACKWARDS into the past
        // (`extended` is always in the future, but `hard_cap` might not be),
        // letting anyone close the raffle immediately - the opposite of what
        // the anti-snipe extension exists to prevent. `max(current_deadline,
        // ...)` on the extension branch below guarantees the deadline is
        // monotonically non-decreasing, matching the invariant this field's
        // own doc comment already claims.
        //
        // Known, accepted edge (round-11 audit, Opus): if `min_players` is
        // reached only after `hard_cap` has already passed (a raffle that
        // sat below the minimum for the entire 60-day window - `ExpireRaffle`
        // is the intended path for that, but nothing forces anyone to call
        // it before someone finally buys the ticket that reaches min_players),
        // the INITIAL deadline is born already elapsed: `min(proposed,
        // hard_cap)` collapses to `hard_cap`, which is already in the past.
        // `CloseRound` becomes callable in the very next transaction, with
        // zero real marketing window and no anti-snipe grace. This is the
        // direct, intended consequence of the hard-cap clamp above (a raffle
        // this stale has no real window left to give), not a bug - the
        // creator's own `ExpireRaffle`-shaped remedy for a raffle that never
        // gets there is separate and unaffected.
        let opened_at = raffle.opened_at.unwrap_or(env.block.time);
        let hard_cap = opened_at.plus_seconds(MAX_RAFFLE_AGE_SECONDS);
        match raffle.deadline {
            None => {
                let proposed = env.block.time.plus_seconds(config.round_timeout_seconds);
                raffle.deadline = Some(std::cmp::min(proposed, hard_cap));
            }
            // `env.block.time < current_deadline` guards the whole branch -
            // 2026-08-20 audit fix (found by a third, independent free-tier
            // review after the two paid models had already signed off on
            // this same soft-close code). Without it, `seconds_remaining`
            // (via `saturating_sub`) floors at 0 once the deadline has
            // already elapsed, which is `<= ANTI_SNIPE_EXTENSION_SECONDS`
            // just like being genuinely inside the final hour - so ANY
            // ticket purchase after the deadline already passed (still
            // legal: BuyTicket never checks the deadline, only CloseRound
            // does) would extend it another hour, indefinitely, up to the
            // 60-day hard cap. That's exactly the "a couple of well-timed
            // late purchases stretch the raffle out" failure mode the
            // soft-close design was built to prevent in the first place
            // (see this field's own doc comment) - it just snuck back in
            // through the extension branch instead of a full reset.
            Some(current_deadline) if env.block.time < current_deadline => {
                let seconds_remaining = current_deadline.seconds() - env.block.time.seconds();
                if seconds_remaining <= ANTI_SNIPE_EXTENSION_SECONDS {
                    let extended = env.block.time.plus_seconds(ANTI_SNIPE_EXTENSION_SECONDS);
                    let clamped = std::cmp::min(extended, hard_cap);
                    raffle.deadline = Some(std::cmp::max(current_deadline, clamped));
                }
            }
            Some(_) => {}
        }
    }

    let auto_closed = raffle.unique_players.len() as u32 >= config.max_players;
    let mut messages: Vec<SubMsg> = vec![];
    if auto_closed {
        // Sold out. Airdrop resolves immediately (no preimage needed - see
        // `resolve_airdrop`'s doc comment); SingleWinner/Podium just close
        // and wait for a separate, permissionless `RevealDraw` - v9 removed
        // the old atomic in-transaction draw here (it used to call
        // `perform_draw` directly, seeded by this very transaction's own
        // block data - exactly the grinding hole the project's Obsidian
        // notes on "Grinding vía SubMsg+reply" describe). Always safe to
        // close immediately here - max_players >= min_players is enforced
        // at instantiate, so reaching max_players already implies
        // min_players is met.
        if config.raffle_type == RaffleType::Airdrop {
            messages = resolve_airdrop(&config, &mut raffle, env.block.time);
        } else {
            raffle.status = RaffleStatus::Closed;
            raffle.closed_at = Some(env.block.time);
            raffle.closed_at_height = Some(env.block.height);
        }
    }

    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_submessages(messages)
        .add_attribute("action", "buy_ticket")
        .add_attribute("buyer", info.sender)
        .add_attribute("auto_closed", auto_closed.to_string()))
}

/// Self-service refund for a wallet's own tickets, callable only while
/// `min_players` hasn't been reached yet for SingleWinner/Podium -
/// deliberately no minimum wait time before a second player shows up, since
/// the player can simply leave whenever they lose interest instead of being
/// locked in. Once `min_players` is reached this stops working there, the
/// same way `CloseRound`/`DrawWinner` treat that as the point the raffle is
/// genuinely "in play" for everyone in it - specifically, the point past
/// which letting someone see the live wallet concentration and bail lets
/// them dodge unfavorable draw odds unfairly. Mirrors Wheel Manager's
/// `WithdrawTicket` exactly for those two types.
///
/// Airdrop is exempt from the `min_players` lock entirely (2026-08-23 fix,
/// found live by the user testing a real airdrop) - there's no draw to
/// protect the integrity of, since every payout is a deterministic
/// `prize_amount / unique_players` split, not odds. The lock's real
/// justification above simply doesn't exist here, and keeping it created a
/// genuine honeypot: `ticket_revenue` refunds to the creator in full
/// regardless of raffle_type (see `perform_draw`), so a creator could buy
/// just enough of their own tickets to hit `min_players` in two
/// transactions, instantly and permanently locking any real participant who
/// joins afterward into a split they can never exit, even a guaranteed-loss
/// one their own worst-case disclosure already warned them about before
/// their `min_players`-reaching ticket ever committed. Letting a wallet
/// leave a locked Airdrop costs the platform nothing new: it's the same
/// refund-your-own-tickets path already used pre-lock, and it can only ever
/// shrink `unique_players`/`ticket_revenue`, the same direction `CloseRound`
/// already re-checks `min_players` for at close time (see its own comment) -
/// a raffle that dips below the minimum this way simply can't close until
/// it's topped back up or the `MAX_RAFFLE_AGE_SECONDS` abandonment backstop
/// takes over, not a fund-safety issue.
pub fn execute_withdraw_ticket(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }
    if config.raffle_type != RaffleType::Airdrop && raffle.unique_players.len() as u32 >= config.min_players {
        return Err(ContractError::RaffleAlreadyLocked {});
    }

    let ticket_count = raffle.entrants.iter().filter(|e| **e == info.sender).count();
    if ticket_count == 0 {
        return Err(ContractError::NoTicketsToWithdraw {});
    }

    let refund = config.ticket_price * Uint128::from(ticket_count as u128);
    raffle.entrants.retain(|e| *e != info.sender);
    raffle.unique_players.retain(|e| *e != info.sender);
    if !refund.is_zero() {
        raffle.ticket_revenue = raffle.ticket_revenue.checked_sub(refund).unwrap_or_default();
    }
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: config.ticket_denom,
                    amount: refund,
                }],
            }
            .into(),
        );
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "withdraw_ticket")
        .add_attribute("wallet", info.sender)
        .add_attribute("amount", refund.to_string()))
}

/// Permissionless for anyone once the raffle's own conditions are met
/// (reaches max_players, or the timeout elapses with at least min_players) -
/// same as every other close/draw action platform-wide. The creator gets one
/// extra path on top: they can close early, on their own judgment, without
/// waiting for either condition - they're the one paying for and running
/// this raffle, and are best placed to decide "enough people showed up".
/// Still can't go below min_players even as the creator: DrawWinner enforces
/// that floor separately regardless of how the raffle got closed, so an
/// early close under it would just strand the raffle Closed-but-undrawable.
pub fn execute_close_round(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    // No action here ever expects funds - anything attached would otherwise
    // be silently absorbed with no refund and no record, same class of bug
    // just closed on BuyTicket.
    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }

    let reached_max = raffle.unique_players.len() as u32 >= config.max_players;
    let has_min = raffle.unique_players.len() as u32 >= config.min_players;
    // `deadline` is only ever `Some` once `has_min` first became true (set in
    // execute_buy_ticket) and never cleared afterward - the `&& has_min`
    // below is redundant given that, but kept for symmetry/clarity with the
    // original 3-condition shape rather than restructuring further.
    let deadline_elapsed = raffle.deadline.is_some_and(|d| env.block.time >= d);
    let creator_early_close = info.sender == config.creator && has_min;

    if !(reached_max || (deadline_elapsed && has_min) || creator_early_close) {
        return Err(ContractError::CannotCloseRound {});
    }

    raffle.status = RaffleStatus::Closed;
    raffle.closed_at = Some(env.block.time);
    raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new().add_attribute("action", "close_round"))
}

/// Creator-exclusive at first, unlike CloseRound - the creator paid the
/// service fee and put up the prize, and drawing is the moment the winner
/// gets announced, so they get to be the one who cuts the ribbon and tells
/// their own community first, instead of finding out secondhand that
/// someone else already ran it. A deliberate correction (2026-07-21) from
/// the platform's usual fully-permissionless close/draw pattern - CloseRound
/// stays permissionless for non-creators, only DrawWinner is restricted.
///
/// That exclusivity isn't forever, though: once `unclaimed_deadline_days`
/// has passed since the raffle *closed* (same field/duration already used
/// for sweeping unclaimed Airdrop shares, reused here for a second,
/// separate deadline - not the same clock), anyone can draw it. A raffle
/// reaches `Closed` on its own (auto-close on the last ticket, or anyone's
/// permissionless CloseRound at timeout) - if the creator's wallet is then
/// lost or unresponsive, a `Closed` raffle with no fallback would strand
/// its prize/ticket revenue/fee forever, since CancelRaffle is blocked once
/// Closed. Found by an Opus+Fable review (2026-07-21) of the first,
/// fallback-less version of this creator-only restriction.
pub fn execute_draw_winner(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Closed {
        return Err(ContractError::RaffleNotClosed {});
    }
    if info.sender != config.creator {
        // `closed_at` is always set atomically with status becoming Closed
        // (both the auto-close in execute_buy_ticket and the close below
        // do this), so this is never actually reached - but propagating an
        // error here instead of defaulting to `env.block.time` matters: a
        // silent "now" default would make the fallback deadline recede
        // into the future on every call, permanently defeating the one
        // thing this fallback exists to guarantee. Same defensive pattern
        // ReclaimUnclaimed already uses for its own timestamp field.
        let closed_at = raffle.closed_at.ok_or(ContractError::RaffleNotClosed {})?;
        let fallback_deadline = closed_at.seconds() + config.unclaimed_deadline_days * 86400;
        // Grinding-resistance fallback (2026-07-22): a creator can rearm the
        // window for free, indefinitely, up to `unclaimed_deadline_days` -
        // see `MAX_REARMS_BEFORE_PERMISSIONLESS`'s doc comment for why that's
        // a real risk, not just theoretical. Once the raffle has rearmed
        // that many times without drawing, anyone can draw immediately
        // instead of waiting out the full deadline.
        let rearm_limit_reached = raffle.rearm_count >= MAX_REARMS_BEFORE_PERMISSIONLESS;
        if env.block.time.seconds() < fallback_deadline && !rearm_limit_reached {
            return Err(ContractError::Unauthorized {});
        }
    }
    let required_height = raffle.draw_after_height.unwrap_or(u64::MAX);
    if env.block.height < required_height {
        return Err(ContractError::DrawTooEarly { required_height });
    }
    // Ceiling on the draw window - see wheel-manager's execute_draw_winner
    // for the full rationale. Not an error, just a rearm to a fresh window -
    // *unless* the rearm cap is already spent (2026-07-22 Opus+Fable review):
    // rearming unconditionally here would let the creator keep re-rolling
    // forever whenever no one else bothers to call DrawWinner in the
    // meantime, silently defeating MAX_REARMS_BEFORE_PERMISSIONLESS (that
    // constant only granted *permission* for someone else to draw - it never
    // actually stopped the creator from rearming). Once the cap is spent,
    // there's no more free re-roll for anyone: this call just draws right
    // here, at whatever height it landed on, instead of resetting the window
    // again.
    if env.block.height >= required_height + config.draw_window_blocks
        && raffle.rearm_count < MAX_REARMS_BEFORE_PERMISSIONLESS
    {
        raffle.rearm_count += 1;
        raffle.draw_after_height = Some(env.block.height + config.draw_delay_blocks);
        RAFFLE.save(deps.storage, &raffle)?;
        return Ok(Response::new()
            .add_attribute("action", "rearm_draw_window")
            .add_attribute("new_draw_after_height", raffle.draw_after_height.unwrap().to_string())
            .add_attribute("rearm_count", raffle.rearm_count.to_string()));
    }
    if (raffle.unique_players.len() as u32) < config.min_players {
        return Err(ContractError::NotEnoughPlayers {
            min_players: config.min_players,
        });
    }

    let messages = perform_draw(&config, &mut raffle, env.block.height, env.block.time);
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_submessages(messages)
        .add_attribute("action", "draw_winner")
        .add_attribute("winners", raffle.winners.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(",")))
}

/// SingleWinner/Podium only, permissionless (same reasoning as `CloseRound`'s
/// own permissionless-for-non-creator design: nobody re-picks or influences
/// the winner here, they just re-send an already-fixed share to an already-
/// fixed address) - re-sends the prize share for any winner whose payout
/// hasn't been confirmed paid yet. Added 2026-08-20 audit fix: see
/// `state::RaffleState::prize_paid`'s doc comment for the fund-stranding bug
/// this closes. Re-checks the factory's live blacklist status first
/// (`maybe_clear_prize_blocked`) so a token the admin has since cleared
/// isn't stuck rejecting retries forever.
pub fn execute_retry_prize_payout(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if config.raffle_type == RaffleType::Airdrop {
        return Err(ContractError::IsAirdrop {});
    }
    if raffle.status != RaffleStatus::Drawn {
        return Err(ContractError::RaffleNotDrawn {});
    }

    maybe_clear_prize_blocked(&deps, &config, &mut raffle)?;
    if raffle.prize_blocked {
        RAFFLE.save(deps.storage, &raffle)?;
        return Err(ContractError::PrizeBlocked {});
    }

    let messages: Vec<SubMsg> = raffle
        .prize_paid
        .iter()
        .enumerate()
        .filter(|(_, paid)| !**paid)
        .map(|(i, _)| {
            prize_transfer_submsg(&config.prize_asset, &raffle.winners[i], raffle.prize_shares[i], retry_payout_reply_id(i as u32))
        })
        .collect();
    if messages.is_empty() {
        return Err(ContractError::NothingToRetry {});
    }
    let retried_count = messages.len();

    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_submessages(messages)
        .add_attribute("action", "retry_prize_payout")
        .add_attribute("retried_count", retried_count.to_string()))
}

pub fn execute_claim_airdrop_share(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    // A participant claiming their share is exactly the scenario a phishing
    // frontend could dress up as "pay a small fee to claim" - guard it the
    // same way BuyTicket now is, so a free (or paid) Airdrop's "nobody can
    // lose real money here" guarantee actually holds for this call too.
    reject_unexpected_funds(&info.funds, &[])?;

    if config.raffle_type != RaffleType::Airdrop {
        return Err(ContractError::NotAirdrop {});
    }
    if raffle.status != RaffleStatus::Drawn {
        return Err(ContractError::RaffleNotDrawn {});
    }
    if raffle.reclaimed {
        return Err(ContractError::AlreadyReclaimed {});
    }
    if !raffle.unique_players.contains(&info.sender) {
        return Err(ContractError::NotAParticipant {});
    }
    if AIRDROP_CLAIMS.may_load(deps.storage, info.sender.clone())?.unwrap_or(false) {
        return Err(ContractError::AlreadyClaimed {});
    }
    // Closes the reentrancy gap `AlreadyClaimed` alone leaves open - see
    // `AIRDROP_CLAIM_IN_FLIGHT`'s own doc comment (2026-08-20 audit fix,
    // round 4).
    if AIRDROP_CLAIM_IN_FLIGHT.has(deps.storage, info.sender.clone()) {
        return Err(ContractError::ClaimAlreadyInFlight {});
    }

    // Checked before dispatch, after the cheap checks above - if the prize
    // token is already known-broken, there's no point spending gas
    // discovering that failure again per claimant; short-circuit for
    // everyone once the raffle itself has recorded 3 consecutive failures.
    // Re-checks live first (`maybe_clear_prize_blocked`) so a token the
    // admin has since cleared on the factory doesn't stay stuck forever.
    maybe_clear_prize_blocked(&deps, &config, &mut raffle)?;
    if raffle.prize_blocked {
        RAFFLE.save(deps.storage, &raffle)?;
        return Err(ContractError::PrizeBlocked {});
    }

    if raffle.airdrop_share.is_zero() {
        // Nothing owed - mark claimed immediately, no transfer to dispatch
        // (and nothing that could fail and count against the raffle).
        AIRDROP_CLAIMS.save(deps.storage, info.sender.clone(), &true)?;
        RAFFLE.save(deps.storage, &raffle)?;
        return Ok(Response::new()
            .add_attribute("action", "claim_airdrop_share")
            .add_attribute("claimer", info.sender)
            .add_attribute("share", "0"));
    }

    // NOT marked claimed here - only `handle_airdrop_claim_reply` does that,
    // once the transfer is confirmed. 2026-08-20 audit fix: the old code
    // marked AIRDROP_CLAIMS=true before dispatch, so an honest transfer
    // failure (not just a malicious one) permanently stranded that share -
    // AlreadyClaimed blocked any retry, and ReclaimUnclaimed treated it as
    // already paid.
    RAFFLE.save(deps.storage, &raffle)?;
    // A freshly allocated id per dispatch, not a fixed constant - see
    // `AIRDROP_CLAIM_REPLY_ID_BASE`'s own doc comment for the reentrancy gap
    // a single shared id/slot had (2nd-round audit fix).
    let reply_id = next_airdrop_claim_reply_id(deps.storage)?;
    PENDING_AIRDROP_CLAIMS.save(deps.storage, reply_id, &info.sender)?;
    AIRDROP_CLAIM_IN_FLIGHT.save(deps.storage, info.sender.clone(), &Empty {})?;

    Ok(Response::new()
        .add_submessage(prize_transfer_submsg(&config.prize_asset, &info.sender, raffle.airdrop_share, reply_id))
        .add_attribute("action", "claim_airdrop_share")
        .add_attribute("claimer", info.sender)
        .add_attribute("share", raffle.airdrop_share.to_string()))
}

pub fn execute_reclaim_unclaimed(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    if config.raffle_type != RaffleType::Airdrop {
        return Err(ContractError::NotAirdrop {});
    }
    if raffle.status != RaffleStatus::Drawn {
        return Err(ContractError::RaffleNotDrawn {});
    }
    if raffle.reclaimed {
        return Err(ContractError::AlreadyReclaimed {});
    }
    let drawn_at = raffle.drawn_at.ok_or(ContractError::RaffleNotDrawn {})?;
    let deadline = drawn_at.seconds() + config.unclaimed_deadline_days * 86400;
    if env.block.time.seconds() < deadline {
        return Err(ContractError::UnclaimedDeadlineNotReached {});
    }
    // 2026-08-21 audit fix (round 5): the sweep below only excludes wallets
    // already in AIRDROP_CLAIMS (confirmed paid) - a claim that's dispatched
    // but still awaiting its reply isn't in that map yet, so without this
    // guard the sweep would count that share as unclaimed and take it too,
    // stranding the in-flight claimant's payout once their reply resolves
    // against an already-drained balance. Narrow in practice (needs the
    // creator - the only caller of this message - to also control the prize
    // CW20 well enough to trigger this mid-flight), same class as other
    // residual risks that require controlling the prize token.
    if AIRDROP_CLAIM_IN_FLIGHT.keys(deps.storage, None, None, Order::Ascending).next().is_some() {
        return Err(ContractError::ClaimsStillInFlight {});
    }

    // Swept as "whatever's left" (prize_amount minus what was actually paid
    // out to confirmed claimers), not "unclaimed_count * airdrop_share" -
    // 2026-08-20 audit fix (2nd round). The old formula missed two real
    // amounts: the floor-division remainder from splitting prize_amount
    // across unique_players.len() (always &lt; unique_players.len() units,
    // normally just dust, but never swept anywhere), and, in the degenerate
    // case a tiny prize floors EVERY share to 0 (see the zero-share guard in
    // `execute_claim_airdrop_share`), the entire prize: every wallet gets
    // marked claimed immediately with nothing to transfer, unclaimed_count
    // lands on 0, and the old formula swept literally 0 - permanently
    // stranding 100% of the prize with no path to recover it. Confirmed by
    // an independent reviewer re-testing this exact fix. This formula
    // recovers both cases in one general fix: whatever was genuinely paid
    // out (`airdrop_share * claimed_count`) is the only amount NOT swept.
    let mut claimed_count: u128 = 0;
    for player in &raffle.unique_players {
        let claimed = AIRDROP_CLAIMS.may_load(deps.storage, player.clone())?.unwrap_or(false);
        if claimed {
            claimed_count += 1;
        }
    }
    let paid_out = raffle.airdrop_share * Uint128::from(claimed_count);
    let unclaimed_total = raffle.prize_amount.checked_sub(paid_out).unwrap_or_default();
    raffle.reclaimed = true;
    RAFFLE.save(deps.storage, &raffle)?;

    let mut messages: Vec<CosmosMsg> = vec![];
    if !unclaimed_total.is_zero() {
        messages.push(prize_transfer_msg(&config.prize_asset, &config.creator, unclaimed_total));
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "reclaim_unclaimed")
        .add_attribute("amount", unclaimed_total.to_string()))
}

/// Shared by `CancelRaffle` (creator-initiated) and `ExpireRaffle`
/// (permissionless safety net) - both refund the prize and each buyer's
/// ticket price the same way. `fee_refund` is a parameter rather than always
/// `raffle.fee_amount` so `CancelRaffle` can pass a reduced amount when the
/// SingleWinner/Podium cancellation penalty applies (`ExpireRaffle`, a no-
/// fault safety net for a stalled raffle, always passes the full
/// `raffle.fee_amount` - never penalized).
///
/// Returns the prize-to-creator refund separately, as its own `SubMsg`, from
/// every other refund (ticket refunds to real players, the fee refund) -
/// 2026-08-20 audit fix. Before this split, all of them were plain
/// `add_message`s in one list: a prize token that reverts for EVERYONE (not
/// just third parties - e.g. paused globally by its own admin after this
/// raffle was funded, unrelated to anything the creator or a grinding
/// attacker did) aborted the ENTIRE transaction, which also blocked the
/// ticket refunds to real players and the fee refund - exactly the money
/// `ExpireRaffle` exists to guarantee gets returned regardless of what's
/// wrong with the prize. `handle_cancel_prize_refund_reply` swallows that
/// failure instead: the ticket/fee refunds, always native/always safe to
/// dispatch, go through no matter what happens to the prize leg. Residual,
/// accepted risk: if the prize refund itself fails, there's no retry path
/// built for that narrow case yet - but the money at risk there is only the
/// creator's own voluntary prize contribution, not a third party's, which is
/// the actual security-relevant distinction (same reasoning `prize_blocked`'s
/// own doc comment already applies to a whitelisted-then-broken CW20).
fn cancel_refund_messages(
    config: &crate::state::Config,
    raffle: &crate::state::RaffleState,
    fee_refund: Uint128,
) -> (Vec<SubMsg>, Vec<CosmosMsg>) {
    let mut prize_submsgs: Vec<SubMsg> = vec![];
    if !raffle.prize_amount.is_zero() {
        prize_submsgs.push(
            SubMsg::reply_on_error(
                prize_transfer_msg(&config.prize_asset, &config.creator, raffle.prize_amount),
                CANCEL_PRIZE_REFUND_REPLY_ID,
            )
            .with_gas_limit(PRIZE_TRANSFER_GAS_LIMIT),
        );
    }
    let mut messages: Vec<CosmosMsg> = vec![];
    if !fee_refund.is_zero() {
        messages.push(
            BankMsg::Send {
                to_address: config.creator.to_string(),
                amount: vec![Coin {
                    denom: config.usdc_denom.clone(),
                    amount: fee_refund,
                }],
            }
            .into(),
        );
    }
    if !config.ticket_price.is_zero() {
        for player in &raffle.unique_players {
            let ticket_count = raffle.entrants.iter().filter(|e| *e == player).count() as u128;
            let refund_amount = config.ticket_price * Uint128::from(ticket_count);
            if !refund_amount.is_zero() {
                messages.push(
                    BankMsg::Send {
                        to_address: player.to_string(),
                        amount: vec![Coin {
                            denom: config.ticket_denom.clone(),
                            amount: refund_amount,
                        }],
                    }
                    .into(),
                );
            }
        }
    }
    (prize_submsgs, messages)
}

/// Whether this cancellation is exempt from the SingleWinner/Podium penalty
/// below - true only for the narrow case the penalty was never meant to
/// punish: the prize is a CW20 that was never successfully deposited (the
/// raffle is still `Funding`, `prize_amount` still zero) AND the factory
/// currently reports that same token as blacklisted, OR (paid raffles only)
/// no longer whitelisted. That combination means the creator couldn't have
/// funded this raffle even if they wanted to - the platform revoked the
/// token's approval out from under them, not a change of heart on their
/// part (confirmed with the user, 2026-08-20). Queried live (unlike the
/// penalty percentages themselves, baked in at instantiate) because this is
/// about CURRENT blacklist/whitelist status, not a term the creator was
/// promised up front.
///
/// 2026-08-20 audit fix (2nd round): the whitelist half was missing - a
/// PAID raffle's CW20 prize losing its whitelist approval (`Remove
/// Cw20FromWhitelist`, distinct from being actively blacklisted) blocks
/// `execute_receive`'s live re-check exactly the same way blacklisting
/// does, but the penalty was only ever waived for the blacklist case, so a
/// creator caught by a de-whitelist still ate the base penalty for a
/// platform-side decision they had no part in.
fn cancellation_penalty_waived_by_platform_revocation(
    deps: &DepsMut,
    config: &Config,
    raffle: &RaffleState,
) -> Result<bool, ContractError> {
    if raffle.status != RaffleStatus::Funding || !raffle.prize_amount.is_zero() {
        return Ok(false);
    }
    let PrizeAsset::Cw20 { address } = &config.prize_asset else {
        return Ok(false);
    };
    let blacklisted: bool = deps.querier.query_wasm_smart(
        &config.factory_address,
        &crate::factory_msgs::FactoryQueryMsg::IsCw20Blacklisted { address: address.to_string() },
    )?;
    if blacklisted {
        return Ok(true);
    }
    if !config.ticket_price.is_zero() {
        let whitelisted: bool = deps.querier.query_wasm_smart(
            &config.factory_address,
            &crate::factory_msgs::FactoryQueryMsg::IsCw20Whitelisted { address: address.to_string() },
        )?;
        if !whitelisted {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn execute_cancel_raffle(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    // Same guard as the other funds-less actions above - not one of the 4
    // originally flagged, but the identical gap (not asked for, but included
    // for the same reason: it's the same one-line fix closing the same bug
    // class, not a separate decision).
    reject_unexpected_funds(&info.funds, &[])?;

    if info.sender != config.creator {
        return Err(ContractError::Unauthorized {});
    }
    match raffle.status {
        RaffleStatus::Funding | RaffleStatus::Open => {}
        RaffleStatus::Cancelled => return Err(ContractError::AlreadyCancelled {}),
        RaffleStatus::Closed | RaffleStatus::Drawn => return Err(ContractError::CannotCancel {}),
    }

    // SingleWinner/Podium only, in effect: Airdrop's own
    // cancellation_penalty_base_bps/late_additional_bps are always 0/0 (see
    // Config's own doc comment), so this formula naturally charges Airdrop
    // nothing without a separate raffle_type check here.
    let waived = cancellation_penalty_waived_by_platform_revocation(&deps, &config, &raffle)?;
    let has_min = raffle.unique_players.len() as u32 >= config.min_players;
    let penalty_bps: u64 = if waived {
        0
    } else if has_min {
        // `saturating_add`, not `+` (2026-08-20 audit fix): the real factory
        // already rejects a combination over 10000 at `SetCancellationPenaltyBps`
        // time, so this can only matter for a direct-instantiate bypass
        // lying about its own factory data - but with `overflow-checks =
        // true`, an unvalidated `+` there would panic instead of just
        // producing a nonsensical (and separately clamped below via
        // `multiply_ratio`, which can't exceed the input amount) value.
        config
            .cancellation_penalty_base_bps
            .saturating_add(config.cancellation_penalty_late_additional_bps)
    } else {
        config.cancellation_penalty_base_bps
    };
    let penalty_amount = raffle.fee_amount.multiply_ratio(penalty_bps, 10_000u128);
    let fee_refund = raffle.fee_amount.checked_sub(penalty_amount).unwrap_or_default();

    let (prize_submsgs, mut messages) = cancel_refund_messages(&config, &raffle, fee_refund);
    if !penalty_amount.is_zero() {
        // Forfeited fee - same 50/50 founder/treasury split used for the
        // regular service fee elsewhere (confirmed with the user,
        // 2026-08-20), never the prize.
        let founder_cut = penalty_amount.multiply_ratio(FEE_SPLIT_BPS, FEE_SPLIT_DENOM);
        let treasury_cut = penalty_amount.checked_sub(founder_cut).unwrap_or_default();
        for (addr, amount) in [
            (&config.founder_fee_address, founder_cut),
            (&config.treasury_address, treasury_cut),
        ] {
            if !amount.is_zero() {
                messages.push(
                    BankMsg::Send {
                        to_address: addr.to_string(),
                        amount: vec![Coin {
                            denom: config.usdc_denom.clone(),
                            amount,
                        }],
                    }
                    .into(),
                );
            }
        }
    }

    raffle.status = RaffleStatus::Cancelled;
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_submessages(prize_submsgs)
        .add_messages(messages)
        .add_attribute("action", "cancel_raffle")
        .add_attribute("penalty_amount", penalty_amount.to_string()))
}

/// Permissionless safety net for a raffle nobody bothered finishing: if
/// `min_players` was never reached within `MAX_RAFFLE_AGE_SECONDS` (fixed,
/// 60 days) of opening, anyone can force the same full refund `CancelRaffle` does,
/// without needing the creator to act. Without this, a raffle stuck below
/// `min_players` with an unresponsive creator (lost wallet, lost interest)
/// would strand every ticket buyer's money forever, since `CancelRaffle` is
/// creator-only. Mirrors Wheel Manager's `ExpireRound`, adapted for CYOL's
/// one-shot-raffle shape (terminates to `Cancelled` and refunds immediately
/// in one push, rather than opening a next round and requiring a separate
/// pull-based reclaim per wallet).
pub fn execute_expire_raffle(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut raffle = RAFFLE.load(deps.storage)?;

    reject_unexpected_funds(&info.funds, &[])?;

    if raffle.status != RaffleStatus::Open {
        return Err(ContractError::RaffleNotOpen {});
    }
    let has_min = raffle.unique_players.len() as u32 >= config.min_players;
    let opened_at = raffle.opened_at.unwrap_or(env.block.time);
    let age_reached = env.block.time.seconds() >= opened_at.seconds() + MAX_RAFFLE_AGE_SECONDS;
    if has_min || !age_reached {
        return Err(ContractError::CannotExpireRaffle {});
    }

    // Never penalized - a no-fault safety net for a stalled raffle with an
    // unresponsive creator, not something the creator chose to walk away
    // from (see CancelRaffle's own penalty logic for the case that IS a
    // creator's choice).
    let (prize_submsgs, messages) = cancel_refund_messages(&config, &raffle, raffle.fee_amount);
    raffle.status = RaffleStatus::Cancelled;
    RAFFLE.save(deps.storage, &raffle)?;

    Ok(Response::new()
        .add_submessages(prize_submsgs)
        .add_messages(messages)
        .add_attribute("action", "expire_raffle"))
}
