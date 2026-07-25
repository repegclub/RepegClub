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

// Create Your Own Luck has no rounds (one raffle per contract address) and
// the reveal wheel here isn't gating a spoiler-sensitive personal win - it's
// just "has this browser already watched this raffle's reveal", so it's
// tracked per contract address only, not per wallet: watching without a
// wallet connected is allowed, and a revisit shouldn't re-offer the "Reveal
// winner" button for something already seen (see CyolRevealWheel).
function cyolKey(contractAddress: string): string {
  return `repegclub:cyol-revealed:${contractAddress}`;
}

export function isCyolRevealed(contractAddress: string): boolean {
  try {
    return localStorage.getItem(cyolKey(contractAddress)) === "1";
  } catch {
    return false;
  }
}

export function markCyolRevealed(contractAddress: string): void {
  try {
    localStorage.setItem(cyolKey(contractAddress), "1");
  } catch {
    // Best-effort only - localStorage can be unavailable (private browsing).
  }
}
