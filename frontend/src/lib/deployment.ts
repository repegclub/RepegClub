// Dedicated Wheel Manager testnet deployment for frontend development.
// Redeployed 2026-08-24 (v8): closes 2 real audit findings from a session
// dedicated to bringing Wheel Manager/Weekly Round to the same rigor as
// Create Your Own Luck (2 blind review rounds - Opus/Fable/Nemotron - before
// this redeploy). (1) `instantiate` now validates every numeric field's
// range instead of accepting a pathological value (most dangerously 0)
// unchecked - a bug class already closed in create-your-own-luck. (2)
// `DrawWinner` (permissionless from day one) previously had no cap on how
// many times it could "rearm" its draw window for free, letting a patient
// off-chain grinder wait indefinitely for a favorable block at zero cost -
// now capped at 2 rearms (see MAX_REARMS in execute.rs), and reaching
// max_players in BuyTicket now draws the winner atomically in the same
// transaction instead of leaving a separate, grindable DrawWinner window
// pending. Config unchanged from the 2026-07-15 (v6) redeploy. Contracts
// are immutable/no-migrate by design, so any code change needs a fresh
// address here too. Swap for the real mainnet address once the product
// actually launches. Kept as the default fallback contractAddress
// throughout lib/queryWheelManager.ts and lib/roundActions.ts for any call
// site that hasn't been made tier-aware yet.
export const WHEEL_MANAGER_ADDRESS =
  "terra10zd8g2upl7mpenq7x26kwga046nk8px3a3z3alhvjj4pqx9wt7psh2kz5u";

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
  WHEEL_MANAGER_ADDRESS, // frontenddev8, 1 USDC ticket (moves as uluna on this testnet) - the only active tier
  // "terra1elewq608x55qquvxst6ezft0005vd9e2rknl6dxe82fm44tk3tfsdp0zj6", // tier-lo, 0.5 USDC ticket
  // "terra1844a2nv4z2n6q22n0ejuu7u5fzkryfn5974um5w5nsvqhq35wmxqgcdsyp", // tier-hi, 5 USDC ticket
  // "terra1fjj6kt8ylmmdy5em0ex5ge84ptnyrv2emfqk7gcj54752z6atcqq32f65j", // tier-10, 10 USDC ticket
];

// Weekly Round is platform-wide (a single instance, not one per tier).
// Redeployed 2026-08-24: same 2 audit fixes as Wheel Manager above (see that
// comment) - instantiate bounds validation, and a capped rearm count on
// DrawWeeklyWinner + atomic draw-on-sellout in BuyWeeklyTicket. Config
// unchanged from the 2026-07-16 redeploy (see git history for that entry).
export const WEEKLY_ROUND_ADDRESS =
  "terra12ffs0y8qpk5639fzav778duharexqu3qpv0tuadle5qkluukwacq7jtrv8";

// Create Your Own Luck factory - platform-wide (a single instance, same as
// Weekly Round above). Redeployed 2026-08-23 (raffle code ID 2421, factory
// 2422), see scripts/testnet/deployment-cyol-factory-frontenddev11.json.
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
// revocation; Airdrop exempt from the min_players withdrawal lock entirely
// (WithdrawTicket) - there's no draw to protect there, just a deterministic
// prize/unique_players split, so the lock only created a honeypot (a
// creator could hit min_players with 2 of their own wallets - refunded via
// ticket_revenue regardless of raffle_type - and permanently trap any real
// participant who joined after, even in a guaranteed-loss share); and, found
// live-testing the withdraw fix the same day, a paid Airdrop's service fee
// is now `max(free-tier schedule, 1% of theoretical revenue)` instead of
// pure revenue-based - a $1-ticket, 1000-player paid Airdrop used to pay
// ~$10 vs a free one's $18, ~44% cheaper for taking real money instead of
// none (the tier schedule was originally Airdrop-only and price-independent,
// displaced for paid Airdrop when the revenue formula was introduced
// generically for "paid raffles" on 2026-07-21). Full history in the
// "Create Your Own Luck (seguridad, hallazgos y exploits)" project note.
// This is a schema-breaking change - every raffle instantiated by a
// previous factory is orphaned, InstantiateMsg shape changed on both
// contracts (and this redeploy specifically orphans the two from earlier
// today, ...zddm5mg0sd46d8e and ...94q8p7zfq, whose raffles still carry the
// old lockable WithdrawTicket and/or the undercharged Airdrop fee).
// Any change to either contract needs a fresh factory deploy too, since the
// raffle code ID is fixed at the factory's own instantiate time
// (contracts/create-your-own-luck-factory/src/state.rs, RAFFLE_CODE_ID).
export const CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS =
  "terra12acajzasnhrkldea0yfqtsh64wwzvg29g0wwtfzd95x9qx9yus5q60wja4";
