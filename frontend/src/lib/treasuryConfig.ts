import {
  DIRECT_ORIGIN_CHAINS,
  NOBLE_CHAIN_ID,
  NOBLE_USDC_DENOM,
  TERRA_CLASSIC_CHAIN_ID,
  TERRA_CLASSIC_USDC_DENOM,
  TREASURY_COSMOS,
} from "./onrampConfig";

// Every denom a TreasuryPanel.tsx row might see, mapped to its display
// symbol - built from the same denom constants already used elsewhere in
// this project (DIRECT_ORIGIN_CHAINS' assets, TERRA_CLASSIC_USDC_DENOM)
// instead of re-typing any IBC hash here. All 4 chains' denoms here use 6
// decimals (microToDisplay's own assumption, onrampConfig.ts), so there's
// no per-denom decimals to track alongside the symbol.
const DENOM_SYMBOLS: Record<string, string> = {
  uluna: "LUNC",
  uusd: "USTC",
  [TERRA_CLASSIC_USDC_DENOM]: "USDC",
  [NOBLE_USDC_DENOM]: "USDC",
};
for (const chain of DIRECT_ORIGIN_CHAINS) {
  for (const asset of chain.assets) {
    DENOM_SYMBOLS[asset.denom] = asset.symbol;
  }
}

export function symbolForDenom(denom: string): string {
  return DENOM_SYMBOLS[denom] ?? (denom.startsWith("ibc/") ? "IBC asset" : denom);
}

export type TreasuryChain = {
  chainId: string;
  label: string;
  address: string;
  lcd: string;
  explorerUrl: string;
};

// Same 4 chains the treasury actually holds funds on (DIRECT_ORIGIN_CHAINS
// + Terra Classic itself) - LCDs and the Terra Classic explorer pattern
// reused from treasuryMultisigConfig.ts/the docs reference memory (both
// already validated live), Mintscan for the other 3 (industry-standard
// Cosmos explorer, no prior pick to reuse in this project).
export const TREASURY_CHAINS: TreasuryChain[] = [
  {
    chainId: TERRA_CLASSIC_CHAIN_ID,
    label: "Terra Classic",
    address: TREASURY_COSMOS[TERRA_CLASSIC_CHAIN_ID],
    lcd: "https://terra-classic-fcd.publicnode.com",
    explorerUrl: `https://finder.terra-classic.hexxagon.io/${TERRA_CLASSIC_CHAIN_ID}/address/${TREASURY_COSMOS[TERRA_CLASSIC_CHAIN_ID]}`,
  },
  {
    chainId: NOBLE_CHAIN_ID,
    label: "Noble",
    address: TREASURY_COSMOS[NOBLE_CHAIN_ID],
    lcd: "https://rest.cosmos.directory/noble",
    explorerUrl: `https://www.mintscan.io/noble/address/${TREASURY_COSMOS[NOBLE_CHAIN_ID]}`,
  },
  {
    chainId: "cosmoshub-4",
    label: "Cosmos Hub",
    address: TREASURY_COSMOS["cosmoshub-4"],
    lcd: "https://rest.cosmos.directory/cosmoshub",
    explorerUrl: `https://www.mintscan.io/cosmos/address/${TREASURY_COSMOS["cosmoshub-4"]}`,
  },
  {
    chainId: "osmosis-1",
    label: "Osmosis",
    address: TREASURY_COSMOS["osmosis-1"],
    lcd: "https://rest.cosmos.directory/osmosis",
    explorerUrl: `https://www.mintscan.io/osmosis/address/${TREASURY_COSMOS["osmosis-1"]}`,
  },
];
