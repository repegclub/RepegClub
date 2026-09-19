import { ulunaToDisplayNumber } from "./format";
import { PRIZE_ASSET_DENOMS } from "./cyolPrizeDenoms";

// Real mainnet denoms (2026-09-19): uusd is USTC, uluna is real LUNC, and
// USDC now has its own real IBC denom - all 3 distinguishable by denom
// string alone, unlike testnet where USDC_DENOM was also "uluna" (see
// cyolPrizeDenoms.ts's own comment). Matches USDC by its exact denom rather
// than defaulting everything-not-uusd/uluna to it (CodeRabbit finding,
// 2026-09-19 review) - a free raffle can use any unrestricted native denom,
// and an unrecognized one now shows as itself instead of being mislabeled.
export function prizeCurrencyLabel(denom: string): string {
  if (denom === "uusd") return "USTC";
  if (denom === "uluna") return "LUNC";
  if (denom === PRIZE_ASSET_DENOMS.usdc) return "USDC";
  return denom;
}

export function formatAmount(amount: string, currency: string): string {
  return `${ulunaToDisplayNumber(amount).toFixed(2)} ${currency}`;
}
