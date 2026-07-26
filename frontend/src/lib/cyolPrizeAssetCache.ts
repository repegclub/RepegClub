import type { PrizeAssetChoice } from "./cyolPrizeDenoms";

// Persists, per browser, which real asset (LUNC/USDC/USTC) the creator
// picked for a raffle's prize at CreateRaffle time - purely a client-side
// aid, same pattern as revealCache.ts. Needed because the on-chain denom
// alone can't distinguish LUNC from USDC on this testnet (both "uluna" -
// see tokenPrices.ts's priceForDenom): without this, the funding screen's
// value-mismatch safety warning and the safety checklist would silently
// price a LUNC prize as USDC ($1/unit), defeating the exact protection
// they exist for. Real gap found live-testing 2026-07-26: a router-state-
// only version of this (passed through navigate()) was lost on any reload
// or revisit, which is the common case for a creator returning later to
// fund a "Funding"-status raffle - localStorage survives that.
//
// This is still a testnet-only workaround, not a real fix - it only helps
// in the same browser that created the raffle. It self-corrects completely
// once mainnet gives USDC its own real, distinct denom (contract.rs's
// USDC_DENOM is already flagged for that swap - see tokenPrices.ts's
// MAINNET TODO), at which point the denom alone becomes unambiguous and
// this cache stops being needed.
function key(contractAddress: string): string {
  return `repegclub:cyol-prize-asset:${contractAddress}`;
}

export function getCachedPrizeAssetChoice(contractAddress: string): PrizeAssetChoice | null {
  try {
    const value = localStorage.getItem(key(contractAddress));
    return value === "usdc" || value === "lunc" || value === "ustc" ? value : null;
  } catch {
    return null;
  }
}

export function setCachedPrizeAssetChoice(contractAddress: string, choice: PrizeAssetChoice): void {
  try {
    localStorage.setItem(key(contractAddress), choice);
  } catch {
    // Best-effort only - localStorage can be unavailable (private browsing).
  }
}
