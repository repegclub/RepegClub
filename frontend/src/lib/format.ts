// All testnet amounts move in uluna (native LUNC) under the hood - real
// USDC/USTC liquidity doesn't exist on rebel-2 (see project notes) - but the
// UI must never say "LUNC": LUNC plays no role in this product's economics,
// it's purely this testnet's stand-in unit. Every amount conceptually means
// either USDC (ticket price, pool, prize - what's paid for a ticket and won)
// or USTC (what a winner sends in to redeem, see redemption_denom) - callers
// must say which so the label is always the real currency, never the denom.
export function formatUluna(amountUluna: string | number, currency: "USDC" | "USTC"): string {
  const luna = Number(amountUluna) / 1_000_000;
  return `${luna.toFixed(2)} ${currency}`;
}

// Plain numeric (no "LUNC" suffix) - for editable amount inputs, e.g. the
// Redeem flow, where the number needs to be user-editable rather than only
// displayed.
export function ulunaToDisplayNumber(amountUluna: string | number): number {
  return Number(amountUluna) / 1_000_000;
}

export function displayNumberToUluna(display: number): string {
  return Math.max(0, Math.round(display * 1_000_000)).toString();
}
