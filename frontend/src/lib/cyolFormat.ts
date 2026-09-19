import { ulunaToDisplayNumber } from "./format";

// Real mainnet denoms (2026-09-19): uusd is USTC, uluna is real LUNC, and
// USDC now has its own real IBC denom - all 3 distinguishable by denom
// string alone, unlike testnet where USDC_DENOM was also "uluna" (see
// cyolPrizeDenoms.ts's own comment). Found live (2026-09-19): this used to
// default anything-not-uusd to "USDC", which would now mislabel a real
// LUNC-denominated prize as USDC instead of just being the old harmless
// testnet ambiguity.
export function prizeCurrencyLabel(denom: string): string {
  if (denom === "uusd") return "USTC";
  if (denom === "uluna") return "LUNC";
  return "USDC";
}

export function formatAmount(amount: string, currency: string): string {
  return `${ulunaToDisplayNumber(amount).toFixed(2)} ${currency}`;
}
