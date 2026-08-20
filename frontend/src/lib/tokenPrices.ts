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
// CoinGecko ids verified live (2026-07-26 for terra-luna/terrausd,
// 2026-08-19 for cosmos/osmosis): "terra-luna" is LUNC/Terra Classic's
// native token (not "terra-luna-2", which is the unrelated Terra 2.0
// chain's new LUNA) - "terrausd" is USTC (not "terrausd-classic", which
// doesn't exist as an id) - "cosmos"/"osmosis" are ATOM/OSMO's real ids
// (added for TreasuryPanel.tsx's USD total, not originally needed by
// CYOL). USDC is assumed exactly $1, no fetch needed.
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=terra-luna,terrausd,cosmos,osmosis&vs_currencies=usd";

export type TokenPrices = {
  lunc: number;
  ustc: number;
  usdc: number;
  atom: number;
  osmo: number;
};

export async function fetchTokenPrices(): Promise<TokenPrices> {
  const res = await fetch(COINGECKO_URL);
  if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status}`);
  const data = await res.json();
  const lunc = data["terra-luna"]?.usd;
  const ustc = data["terrausd"]?.usd;
  const atom = data["cosmos"]?.usd;
  const osmo = data["osmosis"]?.usd;
  if (
    typeof lunc !== "number" ||
    typeof ustc !== "number" ||
    typeof atom !== "number" ||
    typeof osmo !== "number"
  ) {
    throw new Error("CoinGecko response missing expected price fields");
  }
  return { lunc, ustc, usdc: 1, atom, osmo };
}

// Generic symbol -> USD price lookup, for callers (TreasuryPanel.tsx) that
// only have a display symbol (DIRECT_ORIGIN_CHAINS' assets/treasuryConfig.ts's
// symbolForDenom), not CYOL's specific prize-denom/asset-choice types below.
// Returns null for anything not priced here (an unrecognized IBC asset,
// eg.) - callers must treat that as "can't include this in a total", never
// silently as $0 or $1.
export function priceForSymbol(symbol: string, prices: TokenPrices): number | null {
  switch (symbol) {
    case "USDC": return prices.usdc;
    case "ATOM": return prices.atom;
    case "OSMO": return prices.osmo;
    case "LUNC": return prices.lunc;
    case "USTC": return prices.ustc;
    default: return null;
  }
}

// See cyolFormat.ts's prizeCurrencyLabel for the same testnet-only
// ambiguity this mirrors: USDC_DENOM and LUNC_DENOM are both literally
// "uluna" on this testnet (contracts/create-your-own-luck/src/contract.rs) -
// LUNC_DENOM is genuinely "uluna" on every network (it's the chain's own
// staking/gas token), but USDC_DENOM is a testnet-only placeholder there,
// explicitly commented as "swap for the real USDC IBC denom before
// mainnet". Until that swap happens, a denom string alone can't
// distinguish real LUNC from real USDC, so "uluna" is priced as USDC ($1)
// here - consistent with how it's already displayed - which under-prices
// a LUNC-labeled prize on testnet specifically.
//
// MAINNET TODO (found live-testing 2026-07-26, not yet reachable so not
// fixed here): once contract.rs's USDC_DENOM becomes the real IBC hash,
// this function's "uluna" branch must change from `prices.usdc` to
// `prices.lunc` (uluna will only ever mean LUNC once USDC has its own real
// denom), and a new branch must map that real USDC IBC denom to
// `prices.usdc`. Left as-is until that constant actually changes - fixing
// it early would just break testnet, where the collision is real.
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
