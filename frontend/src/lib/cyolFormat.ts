import { ulunaToDisplayNumber } from "./format";

// Same site-wide rule as lib/format.ts's formatUluna: ticket/pool/prize
// amounts always display as USDC, never LUNC (confirmed 2026-07-13 across
// Wheel of Repeg/Weekly Round) - USTC is the one exception, reserved for
// the actual redemption-target currency. CreatorForm's own prize field is
// explicitly labeled "(USDC)" for the same reason. On this testnet,
// USDC_DENOM is "uluna" too (see contracts/create-your-own-luck/src/
// contract.rs) - denom-string lookup alone can't distinguish real LUNC from
// real USDC until mainnet uses their actual distinct denoms.
export function prizeCurrencyLabel(denom: string): string {
  return denom === "uusd" ? "USTC" : "USDC";
}

export function formatAmount(amount: string, currency: string): string {
  return `${ulunaToDisplayNumber(amount).toFixed(2)} ${currency}`;
}
