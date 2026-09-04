import { queryContract } from "@goblinhunt/cosmes/client";

// CW20 balance query, for assets that ride the Hyperlane cw20 warp route
// (onrampConfig.ts's HyperlaneCw20Warp, e.g. JURIS) - the bank-module
// getBalance in queryBalance.ts doesn't apply, a CW20 balance lives in the
// token contract's own storage, not the bank module.
export async function getCw20Balance(address: string, tokenContract: string, rpc: string): Promise<string> {
  const res = await queryContract<{ balance: string }>(rpc, {
    address: tokenContract,
    query: { balance: { address } },
  });
  return res.balance;
}
