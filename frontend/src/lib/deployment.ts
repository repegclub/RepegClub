// Dedicated Wheel Manager testnet deployment for frontend development.
// Redeployed 2026-07-15 (v6) as the "clean" redeploy with production-shaped
// config: draw_window_blocks 60 (was 10, a testing shortcut - the live
// contract before this one didn't even have the field, since its wasm
// predated the 2026-07-14 anti-grinding fix) and unclaimed_deadline_days 90
// (was 0). Contracts are immutable/no-migrate by design, so any code or
// config change needs a fresh address here too. Swap for the real mainnet
// address once the product actually launches. Kept as the default fallback
// contractAddress throughout lib/queryWheelManager.ts and lib/roundActions.ts
// for any call site that hasn't been made tier-aware yet.
export const WHEEL_MANAGER_ADDRESS =
  "terra1nxcnp5u8l2x9plec2qkaf4l9dmac76ldrh5semg0ymd9e7a7zjrqgu0rue";

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
  WHEEL_MANAGER_ADDRESS, // frontenddev6, 1 USDC ticket (moves as uluna on this testnet) - the only active tier
  // "terra1elewq608x55qquvxst6ezft0005vd9e2rknl6dxe82fm44tk3tfsdp0zj6", // tier-lo, 0.5 USDC ticket
  // "terra1844a2nv4z2n6q22n0ejuu7u5fzkryfn5974um5w5nsvqhq35wmxqgcdsyp", // tier-hi, 5 USDC ticket
  // "terra1fjj6kt8ylmmdy5em0ex5ge84ptnyrv2emfqk7gcj54752z6atcqq32f65j", // tier-10, 10 USDC ticket
];

// Weekly Round is platform-wide (a single instance, not one per tier).
// Redeployed 2026-07-15 for its own real frontend page: added GetWeekEntrants
// (needed for the public verification panel, mirroring Wheel Manager's
// GetRoundEntrants - the previous deployment had no way to independently
// recompute a drawn week's winner) and production-shaped config
// (round_duration_days 7, was 1 as a testing shortcut; draw_window_blocks 60,
// same reasoning as Wheel Manager's 2026-07-15 redeploy; max_players 10,
// matching the live $1 Wheel Manager tier).
export const WEEKLY_ROUND_ADDRESS =
  "terra1cph62ylyt75wd0p2kmk7que0689d0nkraslf2405h2ej5adgafdsxj2hvh";
