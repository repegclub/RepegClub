import { ulunaToDisplayNumber } from "./format";

// Labeled by ROLE, not by denom string - ticket/fee amounts are always
// "USDC" conceptually (same convention as the rest of this app, see
// lib/format.ts's formatUluna), while the prize is a real, distinct choice
// from the whitelist (LUNC/USDC/USTC natives). On this testnet (2026-07-23)
// USDC_DENOM itself is "uluna" too (see contracts/create-your-own-luck/src/
// contract.rs), so the same underlying token can mean either role depending
// on context - denom-string lookup alone can't tell them apart anymore.
export function prizeCurrencyLabel(denom: string): string {
  return denom === "uusd" ? "USTC" : "LUNC"; // this UI's CreatorForm only ever creates LUNC prizes; USTC covers older/external raffles
}

export function formatAmount(amount: string, currency: string): string {
  return `${ulunaToDisplayNumber(amount).toFixed(2)} ${currency}`;
}
