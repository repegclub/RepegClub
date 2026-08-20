import { LCD } from "./chainConfig";

// Plain bank balance query - cosmes's client only wraps CosmWasm smart
// queries, not bank module queries, so this goes straight to the LCD (same
// "raw fetch to a public endpoint" pattern already used in verifyRound.ts).
// `lcd` defaults to this project's usual (testnet Terra Classic) endpoint -
// the onramp's Noble balance check is the only caller that overrides it.
export async function getBalance(address: string, denom: string, lcd: string = LCD): Promise<string> {
  const res = await fetch(
    `${lcd}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`
  );
  if (!res.ok) throw new Error(`Balance query failed (${res.status})`);
  const body = await res.json();
  return body?.balance?.amount ?? "0";
}

export type DenomBalance = { denom: string; amount: string };

// Unfiltered bank balance query (every denom the address holds, not just
// one) - for TreasuryPanel.tsx, which doesn't know in advance which denoms
// a given chain's treasury address might be holding. Follows
// pagination.next_key (found in CodeRabbit review, PR #35) - a page holds
// 100 denoms by default, comfortably more than the treasury holds on any
// one chain today, but silently dropping anything past the first page on a
// public balance display is the wrong failure mode to leave in.
export async function getAllBalances(address: string, lcd: string): Promise<DenomBalance[]> {
  const balances: DenomBalance[] = [];
  let key: string | undefined;
  do {
    const url = new URL(`${lcd}/cosmos/bank/v1beta1/balances/${address}`);
    if (key) url.searchParams.set("pagination.key", key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Balance query failed (${res.status})`);
    const body = await res.json();
    balances.push(...(body?.balances ?? []));
    key = body?.pagination?.next_key || undefined;
  } while (key);
  return balances;
}
