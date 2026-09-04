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
// "columbus-5" added 2026-09-02 for the Hyperlane outbound leg further down
// (Terra Classic is the ORIGIN there, unlike every other entry here) -
// TREASURY_COSMOS/FEE_KEEPER_COSMOS already had a columbus-5 entry (used by
// ONRAMP_CHAIN_AFFILIATES's Skip Go config above), so getDirectFeeSplit
// works for it with no other change.
export type DirectFeeChainId = "noble-1" | "cosmoshub-4" | "osmosis-1" | typeof TERRA_CLASSIC_CHAIN_ID;

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
// Found in review (2026-08-18, CodeRabbit): KNOWN_SLIP44_118_CHAIN_IDS
// above and this prefix map used to list these same 5 chains
// independently - nothing enforced they stayed in sync, so adding a chain
// ID to only one of them would surface as a runtime throw in
// deriveAddress instead of a type error. Asserted equal at module load so
// a future drift fails immediately and loudly instead of silently.
if (
  KNOWN_SLIP44_118_CHAIN_IDS.size !== Object.keys(KNOWN_SLIP44_118_CHAIN_PREFIXES).length ||
  ![...KNOWN_SLIP44_118_CHAIN_IDS].every((id) => id in KNOWN_SLIP44_118_CHAIN_PREFIXES)
) {
  throw new Error("KNOWN_SLIP44_118_CHAIN_IDS and KNOWN_SLIP44_118_CHAIN_PREFIXES have drifted apart.");
}

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
// Exported so TreasuryPanel.tsx (the public balance-transparency panel) can
// read the exact same addresses - never hand-retyped elsewhere, same
// principle as importing any other opaque constant instead of copying it.
export const TREASURY_COSMOS = {
  [TERRA_CLASSIC_CHAIN_ID]: "terra1pmrw0x576skdqxel7aakph7nhjscuczn3kke0z",
  [NOBLE_CHAIN_ID]: "noble1pmrw0x576skdqxel7aakph7nhjscucznl3e34v",
  "osmosis-1": "osmo1pmrw0x576skdqxel7aakph7nhjscucznlflfms",
  "cosmoshub-4": "cosmos1pmrw0x576skdqxel7aakph7nhjscucznhjvedz",
};
// Found in review, 2026-08-18: the Noble/Osmosis/Cosmos Hub entries here
// used to be terra1h3898...'s OWN pubkey re-encoded with those chains'
// bech32 prefixes - correct for TREASURY_COSMOS above (a 2-of-3 multisig,
// whose composite pubkey isn't tied to any single chain's coin type), but
// wrong for this wallet: it's a normal individual Keplr account, and Terra
// Classic/Terra 2.0 derive with slip44 coin type 330, not the 118 every
// other chain here uses (see isValidTerraClassicAddress/deriveAddress
// above - this is the exact same bug class that comment already warns
// about, except it slipped into this address table itself instead of a
// runtime derivation). The result: fees landed at addresses this wallet's
// own key controls, but that Keplr never shows when switching to Noble/
// Osmosis/Cosmos Hub with this account (it derives via 118 there,
// landing on a DIFFERENT address) - confusing to audit and indistinguishable
// from funds sent to the wrong place by mistake. Replaced with the
// addresses Keplr actually shows for this same seed on each chain
// (confirmed live: all 3 decode to the same pubkey hash as each other).
const FEE_KEEPER_COSMOS = {
  [TERRA_CLASSIC_CHAIN_ID]: "terra1h3898lq8fyspnlvpwknl9ffu8pttyjvxl7kran",
  [NOBLE_CHAIN_ID]: "noble1gqamtvt98mptup8nhh7sx4uf59h2hfglt82gtr",
  "osmosis-1": "osmo1gqamtvt98mptup8nhh7sx4uf59h2hfgltlvs9l",
  "cosmoshub-4": "cosmos1gqamtvt98mptup8nhh7sx4uf59h2hfglrylqnd",
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

// ---------- Hyperlane warp routes: LUNC/USTC/JURIS leaving Terra Classic (2026-09-02/04) ----------
// Outbound only for now ("salida") - Terra Classic -> BSC/Ethereum/Solana via
// Hyperlane's Warp Routes, merged into the official Hyperlane registry
// 2026-08-31 and re-verified live (2026-09-02) against both the registry's
// own config YAML (hyperlane-registry/deployments/warp_routes/{LUNC,USTC}/)
// and the Terra Classic Hyperlane team's own audited per-token docs
// (terra-classic-hyperlane/cw-hyperlane, WARP-LUNC.md/WARP-USTC.md) - not
// carried over from anything said in chat. The return leg (BSC/Ethereum/
// Solana -> Terra Classic) needs its own EVM/Solana wallet integration this
// project doesn't have yet (see project notes, 2026-09-02) - not built.
export type HyperlaneAsset = "LUNC" | "USTC" | "JURIS";

// LUNC/USTC ride CwHypNative in `collateral` mode: lock the real native coin
// (uluna/uusd) via `funds` on the way out. JURIS (added 2026-09-04, first
// CW20 on this leg) rides CwHypCollateral (`hpl_warp_cw20` on-chain, code_id
// 11389) instead - a wholly different mechanism confirmed by reading the
// real contract source (many-things/cw-hyperlane, contracts/warp/cw20/src/
// contract.rs): `TransferRemote` pulls the CW20 via `TransferFrom`, which
// needs an `IncreaseAllowance` first (onrampActions.ts) - there's no bank
// denom or `funds` involved for this asset at all. `decimals` isn't read
// anywhere yet (JURIS happens to match this project's usual 6, same as
// microToDisplay/displayToMicro below) - kept for the next CW20 added here,
// which might not. Both variants verified live against mainnet 2026-09-04
// (JURIS: contract_info, token_type, token_mode, and list_routes' route
// bytes hand-decoded from base58 and checked byte-for-byte against the
// dev-supplied Solana mint) - not carried over from anything said in chat.
export type HyperlaneNativeWarp = { kind: "native"; denom: string; contract: string };
export type HyperlaneCw20Warp = { kind: "cw20"; tokenContract: string; warpContract: string; decimals: number };

export const HYPERLANE_TERRA_CLASSIC_WARP = {
  LUNC: {
    kind: "native",
    denom: "uluna",
    contract: "terra1m7jcqxfn4hd7q4sywhw508nxshaf078c4vh83y0ts43y9tlp9dcs50cggy",
  },
  USTC: {
    kind: "native",
    denom: "uusd",
    contract: "terra1qu3x6vhk4y6w6erhmedzfp2ug53qm5nwpyarxveqa7tvwg0telxqvd3ccf",
  },
  JURIS: {
    kind: "cw20",
    tokenContract: "terra1vhgq25vwuhdhn9xjll0rhl2s67jzw78a4g2t78y5kz89q9lsdskq2pxcj2",
    warpContract: "terra1dkr5hngjngneqmfrye2fuppckk34uxuxjes5pqzfu59jvncs27uszw8wj5",
    decimals: 6,
  },
} as const satisfies Record<HyperlaneAsset, HyperlaneNativeWarp | HyperlaneCw20Warp>;

export type HyperlaneChainKind = "evm" | "solana";

export type HyperlaneDestination = {
  // Hyperlane's own internal chain numbering, NOT a bech32/EVM chain id -
  // bsc=56 and ethereum=1 happen to match EVM's own chainId, but
  // solanamainnet=1399811149 is Hyperlane-specific. Required as-is by
  // ExecuteMsg::TransferRemote's dest_domain field (onrampActions.ts),
  // confirmed live against the warp contract's own list_routes query.
  domain: number;
  label: string;
  kind: HyperlaneChainKind;
  // The synthetic token contract/program on this destination, per asset -
  // never called directly by this leg (only shown to the user, and kept
  // ready for a future entrada implementation). Partial, not every asset
  // has a route to every destination - JURIS is Solana-only (confirmed
  // directly by Igor, the Terra Classic Hyperlane infra lead, 2026-09-02:
  // Juris only ever deployed the Solana leg). The asset picker in
  // DirectTransferCard.tsx reads this to decide which assets to offer per
  // destination tab, instead of hardcoding "JURIS only on Solana" there.
  tokenAddress: Partial<Record<HyperlaneAsset, string>>;
};

export const HYPERLANE_DESTINATIONS: HyperlaneDestination[] = [
  {
    domain: 56,
    label: "BSC",
    kind: "evm",
    tokenAddress: {
      LUNC: "0x481095ecEd7A907e7f390b6226F53a66D379e6e2",
      USTC: "0xfC067fd98FD123fC2cAd72d040AF60a523274339",
    },
  },
  {
    domain: 1,
    label: "Ethereum",
    kind: "evm",
    tokenAddress: {
      LUNC: "0xA4bc47a4C5461eB0E59A585a21A1222EF7544Ac6",
      USTC: "0xf49408beb319aeCe3E8B3550a5C750C19b3F1e51",
    },
  },
  {
    domain: 1399811149,
    label: "Solana",
    kind: "solana",
    // All 3 of these are the actual SPL/Token-2022 MINT address, not the
    // warp route's own program address (list_routes on the Terra Classic
    // warp contract returns that program address, and it's easy to mix the
    // two up - happened here once already, see JURIS's history below).
    // LUNC/USTC verified 2026-09-04 (audit round, docs/audit-prompts/
    // hyperlane-outbound-onramp/round-01-findings-opus.md, Finding 1):
    // list_routes' route bytes for these two, base58-encoded, reproduce the
    // OLD wrong values here exactly (Dd3ajD8W.../7CUdBt1Q...) - getAccountInfo
    // on those confirms they're BPFLoaderUpgradeab1e-owned *programs*, not
    // mints. The real mints (independently confirmed here too - real
    // Token-2022 mints, 6 decimals, tokenMetadata name "Luna Classic"/"Terra
    // Classic USD") are the values now in place below.
    tokenAddress: {
      LUNC: "8dxTo5reLtvRDx3Q8WEP33Uj2C5u6372EygJdNbsLFKG",
      USTC: "GNUbsF5mrurtDzNc65HipN5Fyzzzqbj5UonLNhj9frjF",
      // JURIS's synthetic mint on Solana. The previous value here
      // (8pktAA5FdXJta2V1U1xzRz5GBcpqH7gTjfFQirJTpZfm) was actually the
      // route's recipient/program address from list_routes, not the mint -
      // confirmed wrong, and this one confirmed correct, by querying the
      // real token account a real transferRemote to this route created
      // (getTokenAccountsByOwner on mainnet, 2026-09-04): mint field is
      // this address, matching the JURIS/USDC pair already verified on
      // Dexscreener/Raydium.
      JURIS: "HmKUJLZGTyFbEUX5sDisr8PERHjJRyoAkgZwc2YsbeRr",
    },
  },
];

// Terra Classic MAINNET (columbus-5), used only as the wallet-connection
// target for the Hyperlane outbound leg above - shaped as a
// DirectOriginChain purely to reuse useCosmosWallet/DirectFeeChainId as-is,
// even though Terra Classic is never an "origin chain" in the direct-
// transfer sense (nothing lands HERE from this chain - it's the far end of
// every DIRECT_ORIGIN_CHAINS entry, and the near end of every
// HYPERLANE_DESTINATIONS entry instead). Deliberately separate from
// chainConfig.ts's CHAIN_ID (still testnet rebel-2 for the rest of this
// app) - same reasoning as Noble/Cosmos Hub/Osmosis above, this project's
// onramp tools always run against real mainnet chains regardless of the
// testnet flag.
export const TERRA_CLASSIC_MAINNET: DirectOriginChain = {
  chainId: TERRA_CLASSIC_CHAIN_ID,
  label: "Terra Classic",
  assets: [
    { denom: HYPERLANE_TERRA_CLASSIC_WARP.LUNC.denom, symbol: "LUNC" },
    { denom: HYPERLANE_TERRA_CLASSIC_WARP.USTC.denom, symbol: "USTC" },
  ],
  bech32Prefix: "terra",
  rpc: "https://rpc.terra-classic.hexxagon.io",
  lcd: "https://lcd.terra-classic.hexxagon.io",
  // Same 28.325uluna this project already uses for testnet (chainConfig.ts)
  // - confirmed live (2026-09-02) that mainnet (columbus-5) and testnet
  // (rebel-2) run the identical terra-classic-core v4.0.1 build, but this
  // exact number isn't independently re-verified against mainnet's own
  // min-gas-price. A wrong value here fails safely (the tx is rejected for
  // insufficient fees, no funds move) rather than risking anything - not
  // worth blocking on before a real broadcast test.
  gasPrice: { amount: "28.325", denom: "uluna" },
  // Covers only the ordinary Cosmos tx fee - the much larger Hyperlane IGP
  // payment (1000+ LUNC, live-quoted per destination by
  // queryHyperlaneGas.ts's quoteHyperlaneGasFee) is reserved separately in
  // DirectOutboundForm (DirectTransferCard.tsx), since unlike this flat
  // per-tx amount it varies by destination. Was
  // 50 LUNC, raised 2026-09-04 (audit round, docs/audit-prompts/
  // hyperlane-outbound-onramp/round-01-findings-opus.md, Finding 2) after
  // pulling this project's own real mainnet broadcasts: the 4-message JURIS
  // tx paid 72.87 LUNC, a 3-message LUNC tx paid 68.60 LUNC (both
  // independently re-verified against the LCD) - 50 LUNC left the Max
  // button building an unpayable transaction on the flagship (LUNC) path.
  maxGasReserve: 100_000_000n, // 100 LUNC
  sdkVersion: "sdk53",
};

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
