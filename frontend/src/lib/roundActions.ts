import { MsgExecuteContract } from "@goblinhunt/cosmes/client";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { WHEEL_MANAGER_ADDRESS, WEEKLY_ROUND_ADDRESS } from "./deployment";

// Every action this app broadcasts carries a fixed memo - lets anyone
// reading the chain attribute these transactions to Repeg Club specifically
// (e.g. the prize payout inside a Redeem tx). This only covers transactions
// our own frontend/keeper bot originate - the memo is a property of the
// broadcasting transaction, not something the contract itself can force on
// its outbound messages, so a third party calling the contract from their
// own wallet/CLI isn't covered.
const MEMO = "REPEG CLUB";

// Base primitive - broadcasts any number of messages as one signed
// transaction. Factored out of execute() (below) so buyTickets/
// buyWeeklyTickets (further down) can reuse the exact same broadcast/
// error-handling path for a multi-message batch, same split as
// cyolActions.ts's own broadcast()/execute().
async function broadcast(wallet: ConnectedWallet, msgs: MsgExecuteContract<object>[]) {
  const res = await wallet.broadcastTxSync({ msgs, memo: MEMO });
  if (res.txResponse.code !== 0) {
    throw new Error(res.txResponse.rawLog || "Transaction failed.");
  }
  return res;
}

async function execute(
  wallet: ConnectedWallet,
  contractAddress: string,
  msg: object,
  funds: { denom: string; amount: string }[] = []
) {
  return broadcast(wallet, [
    new MsgExecuteContract({
      sender: wallet.address,
      contract: contractAddress,
      msg,
      funds,
    }),
  ]);
}

export function buyTicket(
  wallet: ConnectedWallet,
  ticketDenom: string,
  ticketPriceAmount: string,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { buy_ticket: {} }, [
    { denom: ticketDenom, amount: ticketPriceAmount },
  ]);
}

// Buys `quantity` tickets in one signature instead of one tx per ticket -
// same batching approach as CYOL's own buyTickets (cyolActions.ts):
// BuyTicket has no quantity field on the contract side, so this just packs
// `quantity` copies of the same message into one broadcast, executed in
// order against the state the previous one left. Atomic - if a later
// ticket in the batch would fail (cap exceeded, round sells out mid-batch),
// the whole batch reverts instead of buying a partial amount, so the
// caller is expected to keep `quantity` within availableTickets (see
// lib/ticketAvailability.ts) to avoid that in practice.
export function buyTickets(
  wallet: ConnectedWallet,
  ticketDenom: string,
  ticketPriceAmount: string,
  quantity: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  const msgs = Array.from(
    { length: quantity },
    () =>
      new MsgExecuteContract({
        sender: wallet.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: ticketDenom, amount: ticketPriceAmount }],
      })
  );
  return broadcast(wallet, msgs);
}

// Both permissionless per the contract design - any connected wallet can
// call these, not just the round's players or an admin. In production this
// normally happens automatically via the keeper bot (scripts/testnet/src/
// keeper.ts); exposing them here too is a genuine fallback, not just a
// testing convenience.
export function closeRound(wallet: ConnectedWallet, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return execute(wallet, contractAddress, { close_round: {} });
}

// Marks a round Expired once min_players was never reached and
// max_round_age_seconds has elapsed - permissionless, opens the next round
// automatically. See ReclaimTicket below for getting ticket money back.
export function expireRound(wallet: ConnectedWallet, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return execute(wallet, contractAddress, { expire_round: {} });
}

// 3-phase expiration for a Closed round that has gone unrevealed too long
// (the keeper is down or the commit was somehow never assigned) - the v9
// outage safety net, separate from expireRound above (which only covers a
// round that never reached min_players). RequestExpireClosedRound only marks
// intent; a legitimate RevealDraw is still valid after any of these 3 steps
// until ClaimExpiredRound actually refunds everyone.
export function requestExpireClosedRound(
  wallet: ConnectedWallet,
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { request_expire_closed_round: { round_id: roundId } });
}

export function finalizeExpireClosedRound(
  wallet: ConnectedWallet,
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { finalize_expire_closed_round: { round_id: roundId } });
}

export function claimExpiredRound(
  wallet: ConnectedWallet,
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { claim_expired_round: { round_id: roundId } });
}

// Refunds exactly what this wallet paid in an Expired round's tickets.
export function reclaimTicket(
  wallet: ConnectedWallet,
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { reclaim_ticket: { round_id: roundId } });
}

// Self-service refund for a wallet's own tickets in the still-Open current
// round, only while min_players hasn't been reached yet - deliberately no
// minimum wait before a second player shows up, since a player can simply
// leave whenever they lose interest instead of being locked in.
export function withdrawTicket(
  wallet: ConnectedWallet,
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { withdraw_ticket: { round_id: roundId } });
}

// Admin-only: sweeps any redemption_denom balance that ended up sitting in
// the contract by mistake (e.g. sent directly instead of via a ticket
// purchase) to the treasury address - the destination is hardcoded in the
// contract, this wallet can only trigger the send, not redirect it.
export function sweepUstc(wallet: ConnectedWallet, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return execute(wallet, contractAddress, { sweep_ustc: {} });
}

// Permissionless per the contract design (no admin gating) - anyone can sweep
// a drawn round's unredeemed prize, or an expired round's abandoned pool,
// once unclaimed_deadline_days has passed. Covers e.g. a winner who lost
// wallet access and can never call Redeem themselves - the funds move to the
// treasury instead of sitting stuck forever.
export function sweepExpiredPrize(
  wallet: ConnectedWallet,
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { sweep_expired_prize: { round_id: roundId } });
}

// Same mechanism, Weekly Round's message just uses week_id instead of round_id.
export function sweepExpiredWeekPrize(wallet: ConnectedWallet, weekId: number, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return execute(wallet, contractAddress, { sweep_expired_prize: { week_id: weekId } });
}

// Weekly Round equivalents below - same permissionless/self-service shape as
// their Wheel Manager counterparts above, just with week_id instead of
// round_id and a rising daily price instead of a fixed one.

export function buyWeeklyTicket(
  wallet: ConnectedWallet,
  ticketDenom: string,
  priceAmount: string,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
) {
  return execute(wallet, contractAddress, { buy_weekly_ticket: {} }, [
    { denom: ticketDenom, amount: priceAmount },
  ]);
}

// Same batching as buyTickets above, for BuyWeeklyTicket - each ticket in
// the batch pays that same day's price (ticketPriceAmount), since the
// day-based ramp only changes once every 24h, not mid-purchase.
export function buyWeeklyTickets(
  wallet: ConnectedWallet,
  ticketDenom: string,
  ticketPriceAmount: string,
  quantity: number,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
) {
  const msgs = Array.from(
    { length: quantity },
    () =>
      new MsgExecuteContract({
        sender: wallet.address,
        contract: contractAddress,
        msg: { buy_weekly_ticket: {} },
        funds: [{ denom: ticketDenom, amount: ticketPriceAmount }],
      })
  );
  return broadcast(wallet, msgs);
}

export function closeWeek(wallet: ConnectedWallet, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return execute(wallet, contractAddress, { close_week: {} });
}

// Marks the current week Expired once min_players was never reached and
// round_duration_days has elapsed - permissionless, opens the next week
// automatically. See reclaimWeeklyTicket below for getting ticket money back.
export function expireWeek(wallet: ConnectedWallet, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return execute(wallet, contractAddress, { expire_week: {} });
}

// Same 3-phase expiration as Wheel Manager's requestExpireClosedRound/etc
// above, week-scoped.
export function requestExpireClosedWeek(
  wallet: ConnectedWallet,
  weekId: number,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
) {
  return execute(wallet, contractAddress, { request_expire_closed_week: { week_id: weekId } });
}

export function finalizeExpireClosedWeek(
  wallet: ConnectedWallet,
  weekId: number,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
) {
  return execute(wallet, contractAddress, { finalize_expire_closed_week: { week_id: weekId } });
}

export function claimExpiredWeek(
  wallet: ConnectedWallet,
  weekId: number,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
) {
  return execute(wallet, contractAddress, { claim_expired_week: { week_id: weekId } });
}

// Refunds exactly what this wallet paid (per that day's price) in an
// Expired week's tickets.
export function reclaimWeeklyTicket(wallet: ConnectedWallet, weekId: number, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return execute(wallet, contractAddress, { reclaim_ticket: { week_id: weekId } });
}

// Self-service refund for a wallet's own tickets in the still-Open current
// week, only while min_players hasn't been reached yet.
export function withdrawWeeklyTicket(wallet: ConnectedWallet, weekId: number, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return execute(wallet, contractAddress, { withdraw_ticket: { week_id: weekId } });
}

// Winner pays in USTC (redemption_denom) and receives an equal amount of the
// ticket_denom (USDC) back, up to prize_remaining - overpayment is
// auto-refunded by the contract.
export function redeemWeekly(
  wallet: ConnectedWallet,
  weekId: number,
  redemptionDenom: string,
  amount: string,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
) {
  return execute(wallet, contractAddress, { redeem: { week_id: weekId } }, [
    { denom: redemptionDenom, amount },
  ]);
}

// Winner pays in USTC (redemption_denom) and receives an equal amount of the
// ticket_denom (USDC) back, up to prize_remaining - overpayment is
// auto-refunded by the contract.
export function redeem(
  wallet: ConnectedWallet,
  roundId: number,
  redemptionDenom: string,
  amount: string,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
) {
  return execute(wallet, contractAddress, { redeem: { round_id: roundId } }, [
    { denom: redemptionDenom, amount },
  ]);
}
