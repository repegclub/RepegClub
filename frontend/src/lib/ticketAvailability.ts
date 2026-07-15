import type { Entrant } from "./wheelData";

// Mirrors contracts/wheel-manager/src/execute.rs::max_tickets_per_wallet
// exactly (max(1, max_players / 2), integer division) - no single wallet
// may hold more than half of a round's max_players worth of tickets.
export function maxTicketsPerWallet(maxPlayers: number): number {
  return Math.max(1, Math.floor(maxPlayers / 2));
}

// How many more tickets could still be sold in this round - personalized
// per viewer, because a flat global countdown would be actively misleading
// right at the critical moment. The round closes INSTANTLY the moment the
// Nth unique wallet buys its first ticket, cutting everyone off from buying
// more in that same round - including that wallet itself. So once exactly
// one new-wallet slot is left: a wallet NOT already in this round sees "1",
// because that's the only ticket their own purchase could ever actually
// land (buying it IS what triggers the close) - showing them a bigger
// theoretical number would overpromise. A wallet already in the round isn't
// the one who'd trigger that close by buying more, so it still sees the
// full theoretical remaining count.
export function computeAvailableTickets(
  entrants: Entrant[],
  maxPlayers: number,
  connectedWallet: string | null
): number {
  const cap = maxTicketsPerWallet(maxPlayers);
  const uniquePlayers = entrants.length;
  const remainingNewWalletSlots = maxPlayers - uniquePlayers;
  if (remainingNewWalletSlots <= 0) return 0;

  const walletAlreadyIn = connectedWallet !== null && entrants.some((e) => e.address === connectedWallet);
  if (remainingNewWalletSlots === 1 && !walletAlreadyIn) {
    return 1;
  }

  const remainingCapOfExisting = entrants.reduce((sum, e) => sum + Math.max(0, cap - e.tickets), 0);
  return remainingCapOfExisting + Math.max(0, remainingNewWalletSlots - 1) * cap + 1;
}
