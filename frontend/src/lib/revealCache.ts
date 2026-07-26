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

// Create Your Own Luck has no rounds (one raffle per contract address). The
// SingleWinner wheel (CyolRevealWheel) is a genuinely public spectacle -
// anyone can watch it, wallet connected or not - so it's tracked per
// contract address only: a revisit shouldn't re-offer "Reveal winner" for
// something already seen, regardless of which wallet (if any) is looking.
//
// The Airdrop chest (CyolRevealChest) started the same way, but became
// wallet-gated later the same session (2026-07-25) - only a participating
// wallet can open it at all, revealing that wallet's own share. Without a
// wallet in the key, one wallet opening the chest would incorrectly mark it
// "already revealed" for every other wallet that ever visits this raffle
// too, skipping their own reveal moment entirely (the exact spoiler this
// whole cache exists to prevent). `wallet` is optional so CyolRevealWheel's
// calls (no wallet) keep behaving exactly as before.
function cyolKey(contractAddress: string, wallet?: string | null): string {
  return wallet
    ? `repegclub:cyol-revealed:${contractAddress}:${wallet}`
    : `repegclub:cyol-revealed:${contractAddress}`;
}

export function isCyolRevealed(contractAddress: string, wallet?: string | null): boolean {
  try {
    return localStorage.getItem(cyolKey(contractAddress, wallet)) === "1";
  } catch {
    return false;
  }
}

export function markCyolRevealed(contractAddress: string, wallet?: string | null): void {
  try {
    localStorage.setItem(cyolKey(contractAddress, wallet), "1");
  } catch {
    // Best-effort only - localStorage can be unavailable (private browsing).
  }
}
