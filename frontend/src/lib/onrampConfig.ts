// Skip Go widget config for the /onramp page. Unlike the rest of this
// testnet frontend, Skip Go has no testnet - IBC only connects real mainnet
// chains, so these are the REAL Terra Classic mainnet chain/denom (Noble USDC
// via IBC channel-149), not the "uluna" testnet stand-in used everywhere else
// in this codebase. Single source of truth for this pair, per the
// integration risk already flagged in project notes: a hand-typed denom in
// JSX would silently deliver the wrong asset instead of erroring.
export const TERRA_CLASSIC_CHAIN_ID = "columbus-5";
export const TERRA_CLASSIC_USDC_DENOM =
  "ibc/0BB9D8513E8E8E9AE6A9D211D9136E6DA42288DDE6CFAA453A150A4566054DC5";
export const NOBLE_CHAIN_ID = "noble-1";
export const NOBLE_USDC_DENOM = "uusdc";
// Noble-side channel for the direct Noble -> Terra Classic hop (port
// "transfer"), counterparty channel-113 on Terra Classic - reconfirmed live
// against the chain immediately before writing this (STATE_OPEN), not
// carried over from an earlier note.
export const NOBLE_TO_TERRA_CLASSIC_CHANNEL = "channel-149";

export const ONRAMP_DEFAULT_ROUTE = {
  destChainId: TERRA_CLASSIC_CHAIN_ID,
  destAssetDenom: TERRA_CLASSIC_USDC_DENOM,
  // This tool only ever brings USDC into Terra Classic - no reason to let
  // the destination side be changed at all.
  destLocked: true,
};

// ---------- Direct-transfer origin chains (2026-08-15) ----------
// Cosmos-family origins this tool signs and broadcasts itself (onrampActions.
// ts) instead of routing through the Skip Go widget below - Noble needs no
// swap at all (plain IBC transfer), and Cosmos Hub/Osmosis route through
// Skip's /route + /msgs APIs (which do the swap-routing work) but WE sign
// the result, so our own fee MsgSend rides in the same signature no matter
// which chain Skip picks for the swap (see onrampActions.ts - this is what
// fixes ATOM's fee never firing through the widget, since that swap venue
// isn't stable chain-to-chain). EVM origins (Ethereum/Arbitrum/Base) stay on
// the widget - signing there needs a real EVM wallet integration, which this
// project has deliberately not built yet (no demand data, 2026-08-15).
// Matches TREASURY_COSMOS/FEE_KEEPER_COSMOS's keys further down - every
// direct-transfer origin needs a fee address on both, so the type system
// catches a chain added to one list but not the other.
export type DirectFeeChainId = "noble-1" | "cosmoshub-4" | "osmosis-1";

export type DirectOriginAsset = {
  denom: string;
  symbol: string;
};

export type DirectOriginChain = {
  chainId: DirectFeeChainId;
  label: string;
  // First entry is the tab's default selection. Noble only ever has one
  // (its native token already IS USDC). Cosmos Hub/Osmosis each list their
  // native token first, then USDC - both denoms verified live against
  // Skip's own asset registry (2026-08-15) as the real Noble-origin USDC,
  // not an Axelar/Wormhole look-alike, and both confirmed to route to our
  // destination as a plain transfer (does_swap: false, 1:1, no swap venue
  // instability) - same mechanism as the native-token case below, no new
  // logic needed in onrampActions.ts, just a different source denom.
  // Gas is always paid in the chain's own native token regardless of which
  // asset here is selected (see gasPrice below) - Cosmos Hub/Osmosis don't
  // have Noble's fee-abstraction, so sending USDC from either still needs
  // a small amount of the native token in the wallet for gas.
  assets: DirectOriginAsset[];
  bech32Prefix: string;
  rpc: string;
  lcd: string;
  gasPrice: { amount: string; denom: string };
  // Rough, deliberately generous buffer (in gasPrice's own denom/decimals)
  // reserved off the top when the "Max" button computes an amount to send
  // in the chain's native token - without this, sending 100% of the
  // balance leaves nothing to pay gas with (gas comes out of the same
  // denom being sent) and the tx reliably fails (found in review,
  // 2026-08-15). Not a real fee simulation - this only has to be "enough"
  // most of the time; the chain still rejects the tx safely (no funds
  // lost) if it's ever not enough. Only applied when the selected asset's
  // denom equals gasPrice.denom - a USDC transfer from Cosmos Hub/Osmosis
  // doesn't need this (gas comes out of ATOM/OSMO instead, a different
  // balance entirely), but still needs a little of the native token
  // sitting in the wallet regardless of which asset is being sent.
  maxGasReserve: bigint;
  // Omitted = cosmes's own default ("sdk47"), correct for most chains.
  // Only set when a chain's real Cosmos SDK version needs the override -
  // confirmed live against each chain's own node_info, 2026-08-15 (do not
  // assume every Cosmos chain is the same; Cosmos Hub already isn't).
  sdkVersion?: "sdk47" | "sdk53";
};

const COSMOSHUB_CHAIN_ID = "cosmoshub-4";
const OSMOSIS_CHAIN_ID = "osmosis-1";

export const DIRECT_ORIGIN_CHAINS: DirectOriginChain[] = [
  {
    chainId: NOBLE_CHAIN_ID,
    label: "Noble",
    assets: [{ denom: NOBLE_USDC_DENOM, symbol: "USDC" }],
    bech32Prefix: "noble",
    rpc: "https://rpc.cosmos.directory/noble",
    lcd: "https://rest.cosmos.directory/noble",
    // Noble's own bank module gas price (chain-registry, confirmed
    // 2026-08-15) - distinct from this project's usual GAS_PRICE (uluna,
    // chainConfig.ts), which has no meaning on Noble at all. Cosmos SDK
    // v0.50.14 (confirmed live) - default sdkVersion is correct.
    gasPrice: { amount: "0.1", denom: NOBLE_USDC_DENOM },
    maxGasReserve: 10_000n, // 0.01 USDC
  },
  {
    chainId: COSMOSHUB_CHAIN_ID,
    label: "Cosmos Hub",
    assets: [
      { denom: "uatom", symbol: "ATOM" },
      // Noble-origin USDC on Cosmos Hub, confirmed live 2026-08-15 against
      // Skip's asset registry.
      { denom: "ibc/F663521BF1836B00F5F177680F74BFB9A8B5654A694D0D2BC249E03CF2509013", symbol: "USDC" },
    ],
    bech32Prefix: "cosmos",
    rpc: "https://rpc.cosmos.directory/cosmoshub",
    lcd: "https://rest.cosmos.directory/cosmoshub",
    gasPrice: { amount: "0.025", denom: "uatom" }, // chain-registry, confirmed 2026-08-15
    maxGasReserve: 10_000n, // 0.01 ATOM
    // Cosmos Hub runs Cosmos SDK v0.53.6 (confirmed live 2026-08-15) - same
    // override chainConfig.ts already needs for Terra Classic, and for the
    // same reason (cosmes defaults to the older sdk47 wire format).
    sdkVersion: "sdk53",
  },
  {
    chainId: OSMOSIS_CHAIN_ID,
    label: "Osmosis",
    assets: [
      { denom: "uosmo", symbol: "OSMO" },
      // Noble-origin USDC on Osmosis, confirmed live 2026-08-15 against
      // Skip's asset registry.
      { denom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4", symbol: "USDC" },
    ],
    bech32Prefix: "osmo",
    rpc: "https://rpc.cosmos.directory/osmosis",
    lcd: "https://rest.cosmos.directory/osmosis",
    gasPrice: { amount: "0.1", denom: "uosmo" }, // chain-registry, confirmed 2026-08-15
    maxGasReserve: 20_000n, // 0.02 OSMO
    // Osmosis runs Cosmos SDK v0.50.14 (confirmed live) - default is correct.
  },
];

// Chains it's safe to derive a recovery address for via deriveAddress()
// (onrampActions.ts) - i.e. confirmed live (chain-registry slip44,
// 2026-08-15) to use the same coin type (118) as the connected origin
// wallet itself. This matters because Terra Classic/Terra 2.0 do NOT
// (they use 330) - re-encoding a 118-derived pubkey with the "terra"
// prefix silently produces a real but DIFFERENT address than the one
// Keplr shows by default for Terra Classic (see project notes,
// 2026-08-15 - this is why the actual Terra Classic destination address
// is never derived this way, only ever pasted in by the user - see
// onrampActions.ts). Cosmos Hub/Osmosis/Noble routes have been seen to
// pass through Neutron and Persistence as intermediate swap venues in
// addition to themselves - all 5 here confirmed 118. Any chain NOT in
// this set encountered in a route's chain_ids refuses the direct
// transfer rather than guess.
export const KNOWN_SLIP44_118_CHAIN_IDS = new Set([
  NOBLE_CHAIN_ID,
  COSMOSHUB_CHAIN_ID,
  OSMOSIS_CHAIN_ID,
  "neutron-1",
  "core-1",
]);

// Bech32 prefix for each chain above - used to derive a recovery address
// for whichever of these a route happens to pass through (onrampActions.ts,
// deriveAddress). MEDIUM finding from review (2026-08-17, second blind-
// audit pass): this used to be fetched live from Skip's own
// `/v2/info/chains` at request time - the exact set of addresses this
// project trusts (validReceivers) was partly built from data supplied by
// the same untrusted API the rest of this file exists to police. A
// tampered response could return the wrong prefix for a chain and get a
// wallet-derived address silently added to validReceivers under the wrong
// encoding. Since KNOWN_SLIP44_118_CHAIN_IDS above is already a fixed,
// hand-verified set (not something that needs Skip's live registry to
// discover), these 5 prefixes are just as fixed and cost nothing extra to
// maintain - standard, long-stable per-chain values, not Skip-specific.
export const KNOWN_SLIP44_118_CHAIN_PREFIXES: Record<string, string> = {
  [NOBLE_CHAIN_ID]: "noble",
  [COSMOSHUB_CHAIN_ID]: "cosmos",
  [OSMOSIS_CHAIN_ID]: "osmo",
  "neutron-1": "neutron",
  "core-1": "persistence",
};

// Skip's own IBC-hooks entry-point contract address, one per chain that can
// appear as an intermediate swap venue in a route (onrampActions.ts uses
// this to recognize the *legitimate* reason a MsgTransfer/MsgExecuteContract
// targets a contract instead of a wallet - the receiver of a swap-via-hook
// message is this contract, not a derived address). This is Skip's own
// infrastructure, not the swap pool inside it - unlike the pool (which
// varies, see KNOWN_SLIP44_118_CHAIN_IDS's comment on core-1/neutron-1/
// phoenix-1), each chain has exactly one of these, versioned by Skip's own
// deploy process. Sourced from Skip's own public deployment records
// (github.com/skip-mev/skip-go-cosmwasm-contracts, deployed-contracts/
// <chain>/mainnet.toml, `entry_point_contract_address`), cross-checked
// 2026-08-17 against 2 of these 3 live on mainnet (Neutron, Osmosis -
// exact match with the real broadcast txs from 2026-08-16). Only covers
// chains already in KNOWN_SLIP44_118_CHAIN_IDS above minus Noble/Cosmos Hub
// (neither has ever been seen as a swap venue - Noble has no CosmWasm at
// all, Cosmos Hub is always the origin in this project's routes, never an
// intermediate hop) - any chain not listed here is already rejected
// upstream by that same set before a route gets this far.
export const SKIP_ENTRY_POINT_CONTRACT_ADDRESSES = new Set([
  "neutron1zvesudsdfxusz06jztpph4d3h5x6veglqsspxns2v2jqml9nhywskcc923", // neutron-1
  "osmo10a3k4hvk37cc4hnxctw4p95fhscd2z6h2rmx0aukc6rm8u9qqx9smfsh7u", // osmosis-1
  "persistence18x2ae7yhd3ggvw4ryp5fjtxz5e0z3ml6srnv3ssqxedvlaqvecyq9pwq2s", // core-1
]);

// Curated source chains, each mapped to the denoms allowed from it - USDC
// contracts verified fresh against Skip's own /v2/fungible/assets on
// 2026-08-14 (never hand-typed) so the filter below can't accidentally let
// through a look-alike/bridged variant (e.g. axlUSDC, USDC.e). USDC chains
// picked to match the exchanges already confirmed to withdraw straight into
// one of these (Binance/KuCoin -> Noble directly, MEXC -> Arbitrum). Native
// assets (ETH/OSMO/ATOM) added on top as the most liquid non-USDC entry
// points - Skip Go swaps them to USDC en route, so someone doesn't need to
// already hold USDC to use this tool. Every entry here (not just the asset
// existing in Skip's catalog) has a real route confirmed live via POST
// /v2/fungible/route to our exact locked destination - BNB Smart Chain was
// tried and dropped after that same check came back "no routes found" even
// for a full BNB (Circle's CCTP, which this route relies on, doesn't cover
// BNB Chain at all) - being listed as an asset doesn't mean a route
// actually exists to a specific destination. BTC deliberately left out too:
// Skip Go has no native Bitcoin chain at all, only wrapped representations
// (e.g. WBTC on Ethereum) - not the same asset a user actually holds.
// Now EVM-only (2026-08-15): Noble/Cosmos Hub/Osmosis used to be listed
// here too, but chainIdsToAffiliates only charges a fee on a swap -
// Noble->TC has no swap at all, and Cosmos Hub/Osmosis's swap can land on a
// different chain every time Skip quotes a route (confirmed live: seen on
// core-1, neutron-1, and phoenix-1 across separate checks the same day) -
// either way the widget would move funds for free but silently never
// collect the service fee. All 3 are handled by a direct, self-signed
// transfer instead now (see DIRECT_ORIGIN_CHAINS above + onrampActions.ts).
// EVM chains stay here because that path genuinely needs the widget - no
// EVM wallet integration of our own (see DIRECT_ORIGIN_CHAINS' comment).
export const ONRAMP_SOURCE_CHAINS: Record<string, string[]> = {
  "1": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "ethereum-native"], // Ethereum: USDC, ETH
  "42161": ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831"], // Arbitrum: USDC
  "8453": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], // Base: USDC
};

// Locks both sides of the widget hard to known chain/denom pairs, so the
// widget itself rejects any other selection rather than relying only on
// defaultRoute being typed correctly. Destination: exactly one chain/denom
// (this tool only ever brings USDC into Terra Classic). Source: only the
// curated chain/denom pairs above - blocks someone from bringing an
// unrelated/illiquid token and getting a bad swap on the way in.
export const ONRAMP_FILTER = {
  source: ONRAMP_SOURCE_CHAINS,
  destination: {
    [TERRA_CLASSIC_CHAIN_ID]: [TERRA_CLASSIC_USDC_DENOM],
  },
};

// Repeg Club's 0.2% service fee, applied uniformly across every chain this
// tool routes through - no partial coverage, this was a business from day
// one (2026-08-15). Split 50/50 everywhere between a treasury-side address
// and the platform-wide fee-keeper wallet - no chain goes 100% to either
// side, so there's no arbitrary-looking asymmetry between chains. The
// fee-keeper wallets are meant to eventually replace the testnet
// placeholder addresses (TREASURY_ADDRESS/ADMIN_FEE_ADDRESS in
// scripts/testnet/src/config.ts) across Wheel of Repeg/Weekly Round/CYOL
// too, not just this onramp - see [[Repeg Club]] project notes. Skip Go's
// chainIdsToAffiliates pays out ON the chain named in each key, so the
// address differs by chain family, not by choice:
// - Cosmos chains (Terra Classic/Noble/Osmosis/Cosmos Hub): treasury side
//   is the real 2-of-3 multisig's key, fee-keeper side is a separate
//   dedicated wallet - each re-encoded with the chain's own bech32 prefix,
//   same mechanism Keplr uses internally when you add a chain, not 8
//   different wallets. Verified with two independent bech32
//   implementations before use, given this is where real fee funds land.
// - EVM chains (Ethereum/Arbitrum/Base): the Cosmos multisig itself has no
//   EVM equivalent (Cosmos SDK multisig is a composite pubkey object with
//   no Ethereum analogue - a real EVM multisig would need a deployed
//   contract like Safe, not something derivable from the existing keys).
//   Treasury side here is instead a single-key EVM wallet the user
//   designated for this ("Repeg Club Treasury" on EVM) - not multisig yet,
//   swept to the real Cosmos multisig manually once it accumulates enough,
//   same spirit as SweepUstc elsewhere in this project.
const TREASURY_COSMOS = {
  [TERRA_CLASSIC_CHAIN_ID]: "terra1pmrw0x576skdqxel7aakph7nhjscuczn3kke0z",
  [NOBLE_CHAIN_ID]: "noble1pmrw0x576skdqxel7aakph7nhjscucznl3e34v",
  "osmosis-1": "osmo1pmrw0x576skdqxel7aakph7nhjscucznlflfms",
  "cosmoshub-4": "cosmos1pmrw0x576skdqxel7aakph7nhjscucznhjvedz",
};
const FEE_KEEPER_COSMOS = {
  [TERRA_CLASSIC_CHAIN_ID]: "terra1h3898lq8fyspnlvpwknl9ffu8pttyjvxl7kran",
  [NOBLE_CHAIN_ID]: "noble1h3898lq8fyspnlvpwknl9ffu8pttyjvx3eet8a",
  "osmosis-1": "osmo1h3898lq8fyspnlvpwknl9ffu8pttyjvx3plnfp",
  "cosmoshub-4": "cosmos1h3898lq8fyspnlvpwknl9ffu8pttyjvxe6vrln",
};
const EVM_TREASURY_ADDRESS = "0xC14112fB044A9353e9F9896Ab22F9F388A62ada3";
const EVM_FEE_KEEPER_ADDRESS = "0x7Ba128C90A0633Ff8E7277f6C35D9Cb27Db6bdf3";

function cosmosSplitAffiliates(chainId: keyof typeof TREASURY_COSMOS) {
  return {
    affiliates: [
      { address: TREASURY_COSMOS[chainId], basisPointsFee: "10" },
      { address: FEE_KEEPER_COSMOS[chainId], basisPointsFee: "10" },
    ],
  };
}

// Same 10+10 bps split as cosmosSplitAffiliates above, computed by hand
// instead of via chainIdsToAffiliates - every direct-transfer origin
// (onrampActions.ts) pays the fee itself in 2 plain MsgSend messages, in
// the same signature as the transfer/swap, rather than relying on Skip
// Go's affiliate mechanism (which never reliably fires for these chains,
// see the note on ONRAMP_SOURCE_CHAINS above). BigInt only - this handles
// real money, floating point has no place in it.
export function getDirectFeeSplit(chainId: DirectFeeChainId, amount: bigint) {
  // The 0.2% total is computed once, then split - truncating each 10bps
  // half independently (the old (amount*10n)/10000n twice) could round
  // BOTH halves down on the same amount, undercharging the declared total
  // fee by up to 1 micro-unit whenever the remainder was >= half
  // (found in review, 2026-08-17).
  const totalFee = (amount * 20n) / 10000n;
  const treasuryAmount = totalFee / 2n;
  const feeKeeperAmount = totalFee - treasuryAmount;
  const transferAmount = amount - treasuryAmount - feeKeeperAmount;
  return {
    treasuryAddress: TREASURY_COSMOS[chainId],
    treasuryAmount,
    feeKeeperAddress: FEE_KEEPER_COSMOS[chainId],
    feeKeeperAmount,
    transferAmount,
  };
}

// Generic 6-decimal micro-unit <-> display number, used for every direct-
// transfer origin's own denom (uusdc, uatom, uosmo all use 6 decimals) -
// same shape as this project's uluna helpers (lib/format.ts) but kept
// separate on purpose, those are documented there as a testnet-only LUNC
// stand-in for a different product surface, not real mainnet money math.
export function microToDisplay(amount: bigint): number {
  return Number(amount) / 1_000_000;
}

// Guards non-finite input (e.g. a pasted "1e999" or an overlong digit
// string, both accepted by <input type="number"> without triggering
// browser validation) - Math.round(Infinity) is still Infinity, and
// BigInt(Infinity) throws a RangeError with no try/catch anywhere upstream
// of this in the render path, which used to white-screen the whole page
// (found in review, 2026-08-15).
export function displayToMicro(display: number): bigint {
  if (!Number.isFinite(display)) return 0n;
  return BigInt(Math.max(0, Math.round(display * 1_000_000)));
}

const evmSplitAffiliates = {
  affiliates: [
    { address: EVM_TREASURY_ADDRESS, basisPointsFee: "10" },
    { address: EVM_FEE_KEEPER_ADDRESS, basisPointsFee: "10" },
  ],
};

// A top-level <Widget> prop, not nested under routeConfig - confirmed by
// reading the widget's own bundled source (it destructures
// chainIdsToAffiliates straight off props before building its internal
// Skip client config), not from the public RouteRequest type, which
// doesn't have this field at all (routeConfig only takes the aggregate
// cumulativeAffiliateFeeBps, not per-chain addresses).
export const ONRAMP_CHAIN_AFFILIATES = {
  [TERRA_CLASSIC_CHAIN_ID]: cosmosSplitAffiliates(TERRA_CLASSIC_CHAIN_ID),
  [NOBLE_CHAIN_ID]: cosmosSplitAffiliates(NOBLE_CHAIN_ID),
  "osmosis-1": cosmosSplitAffiliates("osmosis-1"),
  "cosmoshub-4": cosmosSplitAffiliates("cosmoshub-4"),
  "1": evmSplitAffiliates, // Ethereum
  "42161": evmSplitAffiliates, // Arbitrum
  "8453": evmSplitAffiliates, // Base
};

// Skip Go's built-in "dark" preset renders warning/error copy (e.g.
// "Please enter a valid amount") in a dull gray - doesn't match this site's
// convention of gold for hints and crimson for real errors (see .booth-cap-
// note/.booth-error in wheel.css). Same color variables as the rest of the
// site, not new ones.
// Pinned numbers, not eyeballed - the direct-transfer card (onramp.css,
// .onramp-panel/.onramp-tab/etc) copies these exact pixel values so its own
// rounded corners match the embedded widget's real ones instead of just
// looking "close" (2026-08-15: the whole point of the redesign is that the
// two should be indistinguishable). If either side changes, change both.
export const ONRAMP_BORDER_RADIUS_MAIN = "16px";
export const ONRAMP_BORDER_RADIUS_BUTTON = "12px";
export const ONRAMP_BORDER_RADIUS_PILL = "999px";

export const ONRAMP_THEME = {
  brandColor: "#ffd166", // --gold
  borderRadius: {
    main: ONRAMP_BORDER_RADIUS_MAIN,
    selectionButton: ONRAMP_BORDER_RADIUS_BUTTON,
    ghostButton: ONRAMP_BORDER_RADIUS_PILL,
    modalContainer: ONRAMP_BORDER_RADIUS_MAIN,
    rowItem: ONRAMP_BORDER_RADIUS_BUTTON,
  },
  primary: {
    background: { normal: "#131728" }, // --bg-card
    text: {
      normal: "#f1f4fb", // --text
      lowContrast: "#b9bfd6", // --text-dim
      // Used by the widget's own MainButton for its disabled-state label
      // (e.g. "Please enter a valid amount") - gold-dim reads well against
      // secondary.background below.
      ultraLowContrast: "#b8811f", // --gold-dim
    },
    ghostButtonHover: "#3c4560", // --border-bright
  },
  // secondary.background.normal isn't only the disabled MainButton's
  // background - the widget reuses this same token for asset-icon
  // placeholders, selector rows (e.g. the "USDC" chip), the swap-direction
  // arrow, tooltips, history rows, and input containers. Tried gold (solid,
  // then translucent) here to match the disabled button to the site's gold
  // - both tinted every one of those other elements too, confirmed live as
  // wrong (the user only remembered the disabled pill as gold, not the
  // asset chip or arrow). No separate token exists for "just the disabled
  // button" without disabling the widget's Shadow DOM and targeting its
  // internal (auto-generated, not a stable public API) class names - not
  // worth the breakage risk for a disabled-state color. --black instead of
  // --bg-raised (the original mismatched blue-gray) - true near-black has
  // no blue cast, reads as neutral/muted instead of "wrong color" even
  // though it isn't gold.
  secondary: {
    background: {
      normal: "#05060a", // --black
      transparent: "rgba(5,6,10,0)",
      hover: "#262c3f", // --border
    },
  },
  success: {
    background: "rgba(47,185,104,0.12)",
    text: "#2fb968",
  },
  warning: {
    background: "rgba(255,209,102,0.12)",
    text: "#ffd166", // --gold
  },
  error: {
    background: "rgba(208,30,67,0.12)",
    text: "#ff3a5e", // --crimson-bright
  },
};
