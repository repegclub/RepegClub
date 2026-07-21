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
// Weekly Round above). Redeployed 2026-07-21, see
// scripts/testnet/deployment-cyol-factory-frontenddev3.json. Points at
// raffle code ID 2367 (prize asset whitelist for paid raffles - LUNC/USDC/
// USTC only, no CW20 - plus the reject_unexpected_funds fix across
// BuyTicket/CloseRound/DrawWinner/ClaimAirdropShare/ReclaimUnclaimed/
// CancelRaffle) - any change to the create-your-own-luck contract itself
// needs a fresh factory deploy too, since the code ID is fixed at the
// factory's own instantiate time (contracts/create-your-own-luck-factory/
// src/state.rs, RAFFLE_CODE_ID).
export const CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS =
  "terra168jjdyaq6nrgcv9j0kr0qkkdjrc24e2gm0wehgw20fnvzjc0s7tsrjd3yy";
