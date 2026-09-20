import { PRIZE_ASSET_DENOMS, type PrizeAssetChoice } from "./cyolPrizeDenoms";

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
// 2026-08-19 for cosmos/osmosis/usd-coin): "terra-luna" is LUNC/Terra
// Classic's native token (not "terra-luna-2", which is the unrelated Terra
// 2.0 chain's new LUNA) - "terrausd" is USTC (not "terrausd-classic",
// which doesn't exist as an id) - "cosmos"/"osmosis" are ATOM/OSMO's real
// ids, "usd-coin" is USDC's (all 3 added for TreasuryPanel.tsx's USD
// total, not originally needed by CYOL). USDC used to be hardcoded to
// exactly $1 (a real depeg, even a small one, would have silently under/
// over-counted the treasury total) - fetched live now instead, same as
// every other asset here (found in CodeRabbit review, PR #35).
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=terra-luna,terrausd,cosmos,osmosis,usd-coin&vs_currencies=usd";

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
  const usdc = data["usd-coin"]?.usd;
  if (
    typeof lunc !== "number" ||
    typeof ustc !== "number" ||
    typeof atom !== "number" ||
    typeof osmo !== "number" ||
    typeof usdc !== "number"
  ) {
    throw new Error("CoinGecko response missing expected price fields");
  }
  return { lunc, ustc, usdc, atom, osmo };
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

// Real mainnet denoms (2026-09-19) - see cyolPrizeDenoms.ts's own comment,
// fixed in the same pass. "uluna" now only ever means real LUNC (USDC has
// its own real IBC denom since the mainnet redeploy), and that IBC denom
// gets its own branch mapping to prices.usdc.
//
// Returns null for any other denom (CodeRabbit finding, 2026-07-26): a paid
// raffle's prize is always uluna/uusd/the real USDC denom (contract-
// enforced), but a *free* raffle's prize denom isn't restricted at all, and
// this reads whatever raffle is on-chain, not just ones created through
// this exact form - an unrecognized denom must show "can't calculate" to
// its callers, never silently get treated as $1.
export function priceForDenom(denom: string, prices: TokenPrices): number | null {
  if (denom === "uusd") return prices.ustc;
  if (denom === "uluna") return prices.lunc;
  if (denom === PRIZE_ASSET_DENOMS.usdc) return prices.usdc;
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
