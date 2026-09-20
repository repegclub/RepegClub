export type PrizeAssetChoice = "usdc" | "lunc" | "ustc";

// Mirrors contracts/create-your-own-luck/src/contract.rs's
// ALLOWED_PAID_NATIVE_PRIZE_DENOMS exactly - this form only offers these 3
// real native assets, not a factory-whitelisted CW20 (the contract allows
// one as of the 2026-08-20 redesign, but this form doesn't expose CW20 as a
// creator-facing choice yet - see the contract's own doc comment on that
// constant).
// Free raffles aren't restricted at the contract level, but this form
// offers the same 3 either way for simplicity. New assets get added here
// only after the same manual review the contract comment describes
// (liquidity, volume, community standing, and for any future CW20 support,
// confirming no malicious transfer logic) - see the "whitelisting manual"
// pendiente in the project notes.
//
// Real mainnet denoms (2026-09-19) - usdc and lunc used to both map to
// "uluna" on testnet (a real, testnet-only ambiguity - see cyolFormat.ts's
// prizeCurrencyLabel and tokenPrices.ts's priceForDenom for the same
// limitation, fixed there in the same pass) now that contract.rs's
// USDC_DENOM is the real IBC hash. Found live (2026-09-19): "My Bag" was
// still showing LUNC's balance under the USDC row, since this was the one
// place that ambiguity was never just a display quirk - it read the wrong
// wallet balance outright.
export const PRIZE_ASSET_DENOMS: Record<PrizeAssetChoice, string> = {
  usdc: "ibc/0BB9D8513E8E8E9AE6A9D211D9136E6DA42288DDE6CFAA453A150A4566054DC5",
  lunc: "uluna",
  ustc: "uusd",
};

export const PRIZE_ASSET_LABELS: Record<PrizeAssetChoice, string> = {
  usdc: "USDC",
  lunc: "LUNC",
  ustc: "USTC",
};

export const PRIZE_ASSET_CHOICES: PrizeAssetChoice[] = ["usdc", "lunc", "ustc"];
