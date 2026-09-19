// Real mainnet Wheel Manager (columbus-5), deployed 2026-09-10 - see the
// "Repeg Club - Plan de deploy a mainnet" Obsidian note for the full
// checklist and the real gas-cost numbers this deploy actually cost
// (~559 LUNC for all 4 contracts combined). ticket_price 1 USDC (real IBC
// denom via Noble), redemption in real uusd (USTC). Kept as the default
// fallback contractAddress throughout lib/queryWheelManager.ts and
// lib/roundActions.ts for any call site that hasn't been made tier-aware yet.
export const WHEEL_MANAGER_ADDRESS =
  "terra1ludttd29cn8t603supz533ahpvlkega8gtrlg6vv5t620gst2t3qskggtd";

// Every ACTIVE tier (one Wheel Manager instance per ticket price), for the
// tab strip / multi-wheel UI and for lifetime-stats aggregation. Deliberately
// just one entry - launch decision (2026-07-13): start with a single $1 tier
// and no visible "more tiers coming" teaser (this community is wary of
// promises that take a while to deliver), adding tiers one at a time, later,
// once each is proven. TierTabs.tsx already hides itself entirely when this
// array has only one address, so a single-tier list is enough - no other
// code change needed. The other 3 tiers deployed 2026-07-12/13 for building
// and testing the multi-tier UI itself are commented out below, not deleted
// - same wheel_timeout/max_round_age/weekly-round-stub wiring, just
// different ticket_price - re-enable by uncommenting when ready to add them.
export const WHEEL_MANAGER_ADDRESSES = [
  WHEEL_MANAGER_ADDRESS, // frontenddev7, 1 USDC ticket (moves as uluna on this testnet) - the only active tier
  // "terra1elewq608x55qquvxst6ezft0005vd9e2rknl6dxe82fm44tk3tfsdp0zj6", // tier-lo, 0.5 USDC ticket
  // "terra1844a2nv4z2n6q22n0ejuu7u5fzkryfn5974um5w5nsvqhq35wmxqgcdsyp", // tier-hi, 5 USDC ticket
  // "terra1fjj6kt8ylmmdy5em0ex5ge84ptnyrv2emfqk7gcj54752z6atcqq32f65j", // tier-10, 10 USDC ticket
];

// Real mainnet Weekly Round (columbus-5), platform-wide (a single instance,
// not one per tier) - deployed 2026-09-10, same session as Wheel Manager
// above. See scripts/testnet/deployment-weekly-round-mainnet.json.
export const WEEKLY_ROUND_ADDRESS =
  "terra1m00z58xsj0f55dhqvxja8rv0dkrhft7ua50hvw8jhrl0m4ll6qus6yjdqw";

// Real mainnet deploy (columbus-5), 2026-09-10, same session as Wheel
// Manager/Weekly Round above - raffle code ID 11655, this factory's own
// code ID 11656. Any change to either contract needs a fresh factory deploy
// too, since the raffle code ID is fixed at the factory's own instantiate
// time (contracts/create-your-own-luck-factory/src/state.rs, RAFFLE_CODE_ID).
//
// This replaces a first mainnet attempt earlier the same session (raffle
// code ID 11651, factory 11652) that shipped with 3 testnet-placeholder
// constants still hardcoded in contract.rs (FOUNDER_FEE_ADDRESS/
// TREASURY_ADDRESS/USDC_DENOM, found live right after that deploy) -
// contracts are immutable, so that code_id/factory are permanently orphaned,
// never used. Fixed in contract.rs, verified by decoding the wasm bytecode
// this factory's raffle code actually stores on mainnet and confirming the
// real addresses/denom are present and the old testnet ones are absent (not
// just trusting the recompile) - see the Obsidian mainnet deploy plan for
// the full story, including the contract redesign history (14 audit rounds,
// PR #38) this design is otherwise unchanged from.
export const CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS =
  "terra17y9z5jpy9pnd2e95lmgptz6r6krszmrtw6e6edy8cxxskn6ku79s7u2p5x";
