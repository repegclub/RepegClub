import { MsgExecuteContract } from "@goblinhunt/cosmes/client";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { WHEEL_MANAGER_ADDRESS } from "./deployment";

// Every action this app broadcasts carries a fixed memo - lets anyone
// reading the chain attribute these transactions to Repeg Club specifically
// (e.g. the prize payout inside a Redeem tx). This only covers transactions
// our own frontend/keeper bot originate - the memo is a property of the
// broadcasting transaction, not something the contract itself can force on
// its outbound messages, so a third party calling the contract from their
// own wallet/CLI isn't covered.
const MEMO = "REPEG CLUB";

async function execute(
  wallet: ConnectedWallet,
  contractAddress: string,
  msg: object,
  funds: { denom: string; amount: string }[] = []
) {
  const res = await wallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: wallet.address,
        contract: contractAddress,
        msg,
        funds,
      }),
    ],
    memo: MEMO,
  });
  if (res.txResponse.code !== 0) {
    throw new Error(res.txResponse.rawLog || "Transaction failed.");
  }
  return res;
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

// Both permissionless per the contract design - any connected wallet can
// call these, not just the round's players or an admin. In production this
// normally happens automatically via the keeper bot (scripts/testnet/src/
// keeper.ts); exposing them here too is a genuine fallback, not just a
// testing convenience.
export function closeRound(wallet: ConnectedWallet, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return execute(wallet, contractAddress, { close_round: {} });
}

export function drawWinner(wallet: ConnectedWallet, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return execute(wallet, contractAddress, { draw_winner: {} });
}

// Marks a round Expired once min_players was never reached and
// max_round_age_seconds has elapsed - permissionless, opens the next round
// automatically. See ReclaimTicket below for getting ticket money back.
export function expireRound(wallet: ConnectedWallet, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return execute(wallet, contractAddress, { expire_round: {} });
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
export function sweepExpiredWeekPrize(wallet: ConnectedWallet, weekId: number, contractAddress: string) {
  return execute(wallet, contractAddress, { sweep_expired_prize: { week_id: weekId } });
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
