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

export function requiredFeeUsdc(raffleType: CyolCreationType, maxPlayers: number, ticketPriceUsdc: number): number {
  const maxPotentialRevenue = ticketPriceUsdc * maxEntrants(raffleType, maxPlayers);
  const percentFee = maxPotentialRevenue * (PAID_RAFFLE_FEE_BPS / FEE_BPS_DENOM);
  return Math.max(percentFee, MIN_PAID_RAFFLE_FEE_USDC);
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
