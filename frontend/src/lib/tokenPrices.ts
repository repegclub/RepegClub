import type { PrizeAssetChoice } from "./cyolPrizeDenoms";

// Real-world USD prices for the raffle prize denoms this app supports,
// purely to inform a human before they sign - never gates a transaction's
// actual execution (fund movement always trusts the chain, not this). This
// is why CoinGecko's public API (no key, CORS open - verified live
// 2026-07-26) is good enough here, unlike the on-chain pool price that was
// deliberately removed from the contract itself (2026-07-15) for being
// manipulable without a TWAP: manipulating a display-only warning has no
// exploitable payoff.
//
// CoinGecko ids verified live (2026-07-26): "terra-luna" is LUNC/Terra
// Classic's native token (not "terra-luna-2", which is the unrelated Terra
// 2.0 chain's new LUNA) - "terrausd" is USTC (not "terrausd-classic", which
// doesn't exist as an id). USDC is assumed exactly $1, no fetch needed.
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=terra-luna,terrausd&vs_currencies=usd";

export type TokenPrices = {
  lunc: number;
  ustc: number;
  usdc: number;
};

export async function fetchTokenPrices(): Promise<TokenPrices> {
  const res = await fetch(COINGECKO_URL);
  if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status}`);
  const data = await res.json();
  const lunc = data["terra-luna"]?.usd;
  const ustc = data["terrausd"]?.usd;
  if (typeof lunc !== "number" || typeof ustc !== "number") {
    throw new Error("CoinGecko response missing expected price fields");
  }
  return { lunc, ustc, usdc: 1 };
}

// See cyolFormat.ts's prizeCurrencyLabel for the same testnet-only
// ambiguity this mirrors: USDC_DENOM and LUNC_DENOM are both literally
// "uluna" on this testnet (contracts/create-your-own-luck/src/contract.rs),
// so a denom string alone can't distinguish real LUNC from real USDC until
// mainnet uses their actual distinct denoms - "uluna" is priced as USDC
// ($1) for now, consistent with how it's already displayed. This
// under-prices a LUNC-labeled prize on testnet specifically; it
// self-corrects the moment mainnet's real LUNC denom is wired in.
//
// Returns null for any other denom (CodeRabbit finding, 2026-07-26): a paid
// raffle's prize is always uluna/uusd (contract-enforced), but a *free*
// raffle's prize denom isn't restricted at all, and this reads whatever
// raffle is on-chain, not just ones created through this exact form - an
// unrecognized denom must show "can't calculate" to its callers, never
// silently get treated as $1.
export function priceForDenom(denom: string, prices: TokenPrices): number | null {
  if (denom === "uusd") return prices.ustc;
  if (denom === "uluna") return prices.usdc;
  return null;
}

// Use this instead of priceForDenom wherever the creator's actual choice is
// still known (CreatorForm, before Instantiate) rather than only a denom
// string read back from chain - real bug found live (2026-07-26): picking
// LUNC still priced the planning disclosure at $1/unit, because
// priceForDenom("uluna") can't tell LUNC and USDC apart (see above) and this
// form's own `prizeAssetChoice` state is exactly the information that
// disambiguates them. Post-creation views (RaffleDetailPage,
// CyolSafetyChecklist) only ever have the denom string, so they keep using
// priceForDenom and inherit its testnet-only LUNC/USDC ambiguity - that's a
// real, accepted limitation, not something this function should paper over.
export function priceForAsset(choice: PrizeAssetChoice, prices: TokenPrices): number {
  if (choice === "lunc") return prices.lunc;
  if (choice === "ustc") return prices.ustc;
  return prices.usdc;
}
