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

// Assumes 6 decimals for every prize, same as uluna (CodeRabbit flagged this
// as a "heavy lift" finding, 2026-09-19 review - considered and deliberately
// not resolved yet). True today because CreatorForm.tsx's prizeAssetChoice
// only ever offers the 3 known native assets (USDC/LUNC/USTC via
// PRIZE_ASSET_DENOMS, all genuinely 6 decimals) - prize_cw20_address is
// hardcoded to null in createRaffle.ts, so a creator can't actually pick a
// CW20 or an arbitrary native denom yet, even though the contract itself
// already allows a CW20 prize on a free Airdrop raffle without restriction
// (no ticket-buyer funds at risk there - confirmed with the user 2026-09-19).
// Opening that field for Airdrop creators is the next real priority (it's
// where the tool starts earning fees from creator usage) - when it lands,
// this needs real per-token decimals (from the CW20's own contract query),
// not this constant.
export function formatAmount(amount: string, currency: string): string {
  return `${ulunaToDisplayNumber(amount).toFixed(2)} ${currency}`;
}
