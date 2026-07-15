import { LCD } from "./chainConfig";

// Plain bank balance query - cosmes's client only wraps CosmWasm smart
// queries, not bank module queries, so this goes straight to the LCD (same
// "raw fetch to a public endpoint" pattern already used in verifyRound.ts).
export async function getBalance(address: string, denom: string): Promise<string> {
  const res = await fetch(
    `${LCD}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`
  );
  if (!res.ok) throw new Error(`Balance query failed (${res.status})`);
  const body = await res.json();
  return body?.balance?.amount ?? "0";
}
