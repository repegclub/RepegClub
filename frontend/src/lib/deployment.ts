// Dedicated Wheel Manager testnet deployment for frontend development.
// Redeployed 2026-07-19 (v7): fixed execute_reclaim_ticket never calling
// subtract_invested, so a wallet's lifetime total_invested stat stayed
// inflated forever after reclaiming an expired round's ticket (money was
// refunded, the stat wasn't updated to match) - same bug, same fix pattern
// already used by withdraw_ticket. Confirmed live on-chain against this
// wasm (buy -> expire -> reclaim -> GetWalletStats back to 0), not just in
// unit tests. Config unchanged from the 2026-07-15 (v6) redeploy. Contracts
// are immutable/no-migrate by design, so any code change needs a fresh
// address here too. Swap for the real mainnet address once the product
// actually launches. Kept as the default fallback contractAddress
// throughout lib/queryWheelManager.ts and lib/roundActions.ts for any call
// site that hasn't been made tier-aware yet.
export const WHEEL_MANAGER_ADDRESS =
  "terra1u40ennkhqnu9rk74kta40cwcuz3svjzrhj8fv44wwllteca3tzns9xc994";

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

// Weekly Round is platform-wide (a single instance, not one per tier).
// Redeployed 2026-07-19: same execute_reclaim_ticket/subtract_invested fix
// as Wheel Manager above (see that comment) - weekly-round had the
// identical gap. Confirmed by an independent Opus+Fable review before this
// redeploy, same pattern as the 2026-07-16 draw_height fix. Config
// unchanged from the 2026-07-16 redeploy (see git history for that entry).
export const WEEKLY_ROUND_ADDRESS =
  "terra1v8fp028mtyehfltg98uy7l3t83a7jz8rf74ncejdfwkd342y2hes2vml8h";

// Create Your Own Luck factory - platform-wide (a single instance, same as
// Weekly Round above). Redeployed 2026-08-23 (raffle code ID 2419, factory
// 2420), see scripts/testnet/deployment-cyol-factory-frontenddev10.json.
// This is the contract redesign from 14 rounds of audit (PR #38): soft-close
// deadline (creator-window + anti-snipe extension + 60-day hard cap)
// replacing the old fixed post-min_players timeout; CW20 whitelist/blacklist
// moved into this factory (checked at raffle instantiate and again at CW20
// deposit) instead of living per-raffle; prize/airdrop payouts switched from
// all-or-nothing `add_message` to `SubMsg`+`reply` to close a grind-and-
// retry exploit and a class of locked-funds bugs, with a permissionless
// RetryPrizePayout and a 3-strike auto-blacklist for malicious tokens; a
// 20%/80% cancellation penalty (bps configurable on this factory) for
// Single Winner/Podium, waived for Airdrop and for platform-driven CW20
// revocation; and, found live-testing the redeployed PR #38 code the same
// day, Airdrop is now exempt from the min_players withdrawal lock entirely
// (WithdrawTicket) - there's no draw to protect there, just a deterministic
// prize/unique_players split, so the lock only created a honeypot (a
// creator could hit min_players with 2 of their own wallets - refunded via
// ticket_revenue regardless of raffle_type - and permanently trap any real
// participant who joined after, even in a guaranteed-loss share). Full
// history in the "Create Your Own Luck (seguridad, hallazgos y exploits)"
// project note. This is a schema-breaking change - every raffle
// instantiated by a previous factory is orphaned, InstantiateMsg shape
// changed on both contracts (and this redeploy specifically orphans the
// PREVIOUS redeploy from earlier today, ...zddm5mg0sd46d8e, whose raffles
// still carry the old, lockable WithdrawTicket).
// Any change to either contract needs a fresh factory deploy too, since the
// raffle code ID is fixed at the factory's own instantiate time
// (contracts/create-your-own-luck-factory/src/state.rs, RAFFLE_CODE_ID).
export const CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS =
  "terra1hzrnvy0d6njzjrwnx3f6kedruqgkl2rardhw9p6fdarh84v7994q8p7zfq";
