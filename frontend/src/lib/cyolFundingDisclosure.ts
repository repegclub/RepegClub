// Mirrors contracts/create-your-own-luck/src/execute.rs's
// max_tickets_per_wallet and contract.rs's max_entrants/required_fee_usdc
// (paid-raffle branch only - free raffles aren't creatable via this UI yet,
// see CreatorForm.tsx). Display-only: small floating-point rounding vs the
// contract's exact integer math is fine here, this never gates a
// transaction, only informs a creator planning one.
export type CyolCreationType = "single_winner" | "airdrop";

export function maxTicketsPerWallet(raffleType: CyolCreationType, maxPlayers: number): number {
  if (raffleType === "airdrop") return 1;
  return Math.max(1, Math.floor(maxPlayers / 2));
}

export function maxEntrants(raffleType: CyolCreationType, maxPlayers: number): number {
  const cap = maxTicketsPerWallet(raffleType, maxPlayers);
  return (maxPlayers - 1) * cap + 1;
}

const PAID_RAFFLE_FEE_BPS = 100; // 1%
const FEE_BPS_DENOM = 10_000;
const MIN_PAID_RAFFLE_FEE_USDC = 1; // "$1", in display USDC (not micros)

// Mirrors contract.rs's FREE_RAFFLE_FEE_TIERS_USDC exactly - free Airdrop's
// community-size schedule, and (2026-08-23 fix) also the floor for a PAID
// Airdrop's fee, so a paying creator can never pay less than a free one of
// the same size would. Exported for CreatorForm.tsx's maxPlayersLimit/free-
// tier display too, so there's one copy of this table, not two that could
// drift (the exact bug class this whole fix is closing for the fee itself).
export const AIRDROP_FEE_TIERS_USDC: [number, number][] = [
  [100, 3],
  [300, 7],
  [600, 12],
  [1000, 18],
];
export const MAX_PLAYERS_AIRDROP = AIRDROP_FEE_TIERS_USDC[AIRDROP_FEE_TIERS_USDC.length - 1][0];

function tierFeeUsdc(maxPlayers: number): number | null {
  const tier = AIRDROP_FEE_TIERS_USDC.find(([cap]) => maxPlayers <= cap);
  return tier ? tier[1] : null;
}

// Paid Airdrop is `max(tier schedule, 1% of theoretical revenue)` (2026-08-23
// fix, found live by the user: a $1-ticket, 1000-player Airdrop paid ~$10 vs
// a free one's $18 tier fee - the tier schedule was originally Airdrop-only
// and price-independent, and got displaced for paid Airdrop when the
// revenue-based formula was introduced generically for "paid raffles" on
// 2026-07-21, without carrying the tier floor forward). SingleWinner/Podium
// are unaffected - always pure revenue-based, no tier concept for them.
export function requiredFeeUsdc(raffleType: CyolCreationType, maxPlayers: number, ticketPriceUsdc: number): number {
  const maxPotentialRevenue = ticketPriceUsdc * maxEntrants(raffleType, maxPlayers);
  const percentFee = maxPotentialRevenue * (PAID_RAFFLE_FEE_BPS / FEE_BPS_DENOM);
  const revenueFee = Math.max(percentFee, MIN_PAID_RAFFLE_FEE_USDC);
  if (raffleType === "airdrop") {
    const tierFee = tierFeeUsdc(maxPlayers);
    return tierFee !== null ? Math.max(revenueFee, tierFee) : revenueFee;
  }
  return revenueFee;
}

// The honest, neutral disclosure this function computes: if the raffle
// fills up completely, does ticket revenue alone (which always refunds to
// the creator regardless of who's drawn - see execute.rs's perform_draw)
// net them a profit on top of the prize+fee they're funding? Positive means
// yes - a legitimate fundraiser-style raffle, the CYOL business model by
// design. Negative means the creator is genuinely subsidizing the prize
// even in the best case - a giveaway to their community. Neither is "safe"
// or "unsafe" - this is disclosure, not a security judgment. The actual
// self-dealing risk (is the draw itself rigged) is a separate, orthogonal
// check: does the creator's own wallet buy a ticket here at all (see
// RaffleDetailPage's self-buy warning) - it doesn't depend on this number.
export function worstCaseTicketRevenueProfit(
  raffleType: CyolCreationType,
  maxPlayers: number,
  ticketPriceUsdc: number,
  prizeUsdc: number
): number {
  const maxPotentialRevenue = ticketPriceUsdc * maxEntrants(raffleType, maxPlayers);
  const fee = requiredFeeUsdc(raffleType, maxPlayers, ticketPriceUsdc);
  return maxPotentialRevenue - fee - prizeUsdc;
}

// The other extreme, and previously undisclosed (found live-testing
// 2026-07-26): what if the raffle closes the moment min_players is reached,
// at 1 ticket each - the cheapest way to satisfy it? A fixed prize funded
// upfront against an unknown turnout can leave the creator far worse off
// than they planned for (2 wallets, 1 ticket each, closing immediately to
// split a prize sized for a much bigger pool). feeUsdc is passed in rather
// than recomputed here because the real fee is already fixed at funding
// time from max_players (see requiredFeeUsdc), regardless of how many
// wallets actually end up joining.
export function worstCaseMinParticipationProfit(
  minPlayers: number,
  ticketPriceUsdc: number,
  prizeUsdc: number,
  feeUsdc: number
): number {
  const minRevenue = ticketPriceUsdc * minPlayers;
  return minRevenue - feeUsdc - prizeUsdc;
}
