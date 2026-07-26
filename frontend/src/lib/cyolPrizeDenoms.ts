export type PrizeAssetChoice = "usdc" | "lunc" | "ustc";

// Mirrors contracts/create-your-own-luck/src/contract.rs's
// ALLOWED_PAID_NATIVE_PRIZE_DENOMS exactly - a paid raffle's prize can only
// be one of these 3 real native assets (never CW20 - see the contract's own
// doc comment on that constant for why: a CW20's name/symbol is creator-
// chosen and unverifiable, a native denom's identity can't be spoofed).
// Free raffles aren't restricted at the contract level, but this form
// offers the same 3 either way for simplicity. New assets get added here
// only after the same manual review the contract comment describes
// (liquidity, volume, community standing, and for any future CW20 support,
// confirming no malicious transfer logic) - see the "whitelisting manual"
// pendiente in the project notes.
//
// usdc and lunc both map to "uluna" on this testnet (contract.rs's
// USDC_DENOM/LUNC_DENOM) - a real, testnet-only ambiguity (see
// cyolFormat.ts's prizeCurrencyLabel and tokenPrices.ts's priceForDenom for
// the same limitation elsewhere): once a raffle is created there's no way
// to recover which of the two the creator meant from the denom string
// alone.
//
// MAINNET TODO: only `usdc` changes here, to the real USDC IBC denom
// (contract.rs's USDC_DENOM comment already flags this swap) - `lunc` stays
// "uluna" (LUNC's real denom on every network) and `ustc` stays "uusd"
// (also real everywhere). Do this at the same time as tokenPrices.ts's
// priceForDenom MAINNET TODO - both assume today's testnet collision.
export const PRIZE_ASSET_DENOMS: Record<PrizeAssetChoice, string> = {
  usdc: "uluna",
  lunc: "uluna",
  ustc: "uusd",
};

export const PRIZE_ASSET_LABELS: Record<PrizeAssetChoice, string> = {
  usdc: "USDC",
  lunc: "LUNC",
  ustc: "USTC",
};

export const PRIZE_ASSET_CHOICES: PrizeAssetChoice[] = ["usdc", "lunc", "ustc"];
