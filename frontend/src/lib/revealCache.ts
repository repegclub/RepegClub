// Tracks, per browser, whether a wallet has actually watched the wheel spin
// and reveal a given round's result - purely a client-side/cosmetic concept
// (there's no on-chain notion of "revealed", the outcome is already decided
// the moment DrawWinner executes). Used to stop "My winnings" from offering
// a direct Redeem shortcut before the winner has had the reveal moment on
// the wheel itself - otherwise a winner who connects after someone else
// already drew the winner never gets to watch it happen.
function key(contractAddress: string, roundId: number, wallet: string): string {
  return `repegclub:revealed:${contractAddress}:${roundId}:${wallet}`;
}

export function isRevealed(contractAddress: string, roundId: number, wallet: string): boolean {
  try {
    return localStorage.getItem(key(contractAddress, roundId, wallet)) === "1";
  } catch {
    return false;
  }
}

export function markRevealed(contractAddress: string, roundId: number, wallet: string): void {
  try {
    localStorage.setItem(key(contractAddress, roundId, wallet), "1");
  } catch {
    // Best-effort only - localStorage can be unavailable (private browsing).
  }
}
