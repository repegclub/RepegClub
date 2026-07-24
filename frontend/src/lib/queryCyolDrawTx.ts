import { LCD } from "./chainConfig";

// Finds the transaction that actually paid the prize to a drawn raffle's
// winner, so any participant (not just the winner) can look it up in any
// block explorer/finder and confirm for themselves that the payout really
// happened - same "don't just trust this app" spirit as verifyRound.ts, one
// step simpler (a direct tx lookup instead of recomputing a hash).
//
// Searches for the bank transfer event itself (contract -> winner), not a
// wasm "action=draw_winner" attribute - a raffle that sells out auto-closes
// AND draws in the same BuyTicket call (see execute_buy_ticket/perform_draw
// in the contract), whose transaction only carries "action=buy_ticket".
// Searching the payout transfer directly works for both paths.
//
// Returns null if nothing is found (e.g. an LCD node lagging behind, or an
// older raffle whose event indexing was pruned) - callers should treat that
// as "couldn't confirm right now", not "never happened".
export async function findPrizePayoutTxHash(contractAddress: string, winnerAddress: string): Promise<string | null> {
  const query = `transfer.recipient='${winnerAddress}' AND transfer.sender='${contractAddress}'`;
  const url = `${LCD}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(query)}&order_by=ORDER_BY_ASC&pagination.limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json();
  return body?.tx_responses?.[0]?.txhash ?? null;
}
