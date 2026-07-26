import type { CyolRaffleType } from "./queryCyolRaffle";
import type { CreatorCooldownResponse } from "./queryFactory";

// Mirrors contracts/create-your-own-luck-factory/src/execute.rs's
// UNSAFE_MAX_PLAYERS_THRESHOLD exactly - the factory itself uses this same
// condition (paid, non-Airdrop, max_players below this) to decide whether a
// raffle counts as "cheap to game" and should start the creator's cooldown.
// Surfacing the same threshold here lets a player see the same signal
// before ever buying a ticket, not just after the fact via the cooldown.
export const UNSAFE_MAX_PLAYERS_THRESHOLD = 20;

export function isSmallUnsafeShape(
  raffleType: CyolRaffleType,
  ticketPriceUluna: string,
  maxPlayers: number
): boolean {
  return raffleType !== "airdrop" && ticketPriceUluna !== "0" && maxPlayers < UNSAFE_MAX_PLAYERS_THRESHOLD;
}

export type WalletConcentration = {
  topWallet: string;
  topWalletTickets: number;
  totalTickets: number;
  share: number; // 0-1
};

// Computed from the same one-entry-per-ticket entrants list the rest of the
// page already fetches (see useCyolRaffleDetail) - no separate query needed.
// Returns null when there are no tickets sold yet (nothing to concentrate).
export function walletConcentration(entrants: string[]): WalletConcentration | null {
  if (entrants.length === 0) return null;
  const counts = new Map<string, number>();
  for (const addr of entrants) counts.set(addr, (counts.get(addr) ?? 0) + 1);
  let topWallet = entrants[0];
  let topWalletTickets = 0;
  for (const [addr, count] of counts) {
    if (count > topWalletTickets) {
      topWallet = addr;
      topWalletTickets = count;
    }
  }
  return {
    topWallet,
    topWalletTickets,
    totalTickets: entrants.length,
    share: topWalletTickets / entrants.length,
  };
}

// Display-only bands, no contract equivalent (concentration itself isn't a
// rule the contract enforces, just a signal worth showing) - picked as a
// reasonable default, meant to be tuned after seeing real concentration
// numbers in live testing rather than derived from a hard rule.
export const CONCENTRATION_YELLOW_THRESHOLD = 0.25;
export const CONCENTRATION_RED_THRESHOLD = 0.5;

// "neutral" is for rows that are informational rather than a safety
// judgment (the fundraiser-vs-giveaway disclosure is deliberately not
// red/green - see the security catalog note - and "no tickets sold yet"
// isn't itself a red flag either).
export type ChecklistBand = "green" | "yellow" | "red" | "neutral";

export function concentrationBand(concentration: WalletConcentration | null): ChecklistBand {
  if (concentration === null) return "neutral";
  if (concentration.share > CONCENTRATION_RED_THRESHOLD) return "red";
  if (concentration.share > CONCENTRATION_YELLOW_THRESHOLD) return "yellow";
  return "green";
}

export type CreatorSelfBuy = {
  ticketCount: number;
  totalTickets: number;
  share: number; // 0-1
};

// Distinct from walletConcentration (which just flags whoever the top
// wallet is, regardless of identity) - this specifically checks the
// raffle's own creator, the real self-dealing signal (security catalog's
// hallazgo #1: the creator's own ticket revenue always refunds to them, so
// buying their own tickets costs nothing and just buys extra shots at
// their own prize). Returns null when the creator holds no tickets at all
// - a genuinely clean state, not "unknown".
export function creatorSelfBuy(entrants: string[], creator: string): CreatorSelfBuy | null {
  if (entrants.length === 0) return null;
  const ticketCount = entrants.filter((addr) => addr === creator).length;
  if (ticketCount === 0) return null;
  return { ticketCount, totalTickets: entrants.length, share: ticketCount / entrants.length };
}

// User's exact spec (2026-07-26, found live-testing): majority of tickets
// held by the creator -> red, any smaller but nonzero share -> yellow.
export function creatorSelfBuyBand(selfBuy: CreatorSelfBuy | null): ChecklistBand {
  if (selfBuy === null) return "green";
  return selfBuy.share >= 0.5 ? "red" : "yellow";
}

// Mirrors the factory's own decay rule exactly (execute.rs's
// UNSAFE_STREAK_STALE_AFTER_DAYS=30) - the query itself returns raw stored
// state without recomputing staleness (that only happens lazily, inside the
// next actual CreateRaffle attempt), so this reproduces client-side what the
// contract would compute if the creator tried right now.
const UNSAFE_STREAK_STALE_AFTER_DAYS = 30;

export function cooldownBand(cooldown: CreatorCooldownResponse, nowSec: number): ChecklistBand {
  if (cooldown.next_unsafe_allowed_at === null) return "green";
  if (nowSec < cooldown.next_unsafe_allowed_at) return "red"; // actively blocked right now
  const staleAt = cooldown.next_unsafe_allowed_at + UNSAFE_STREAK_STALE_AFTER_DAYS * 86400;
  return nowSec >= staleAt ? "green" : "yellow"; // cooldown served, but streak not stale yet
}
