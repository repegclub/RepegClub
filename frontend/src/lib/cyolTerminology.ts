// Airdrop has no winner - it's a guaranteed, equal split among whoever
// joins, so "players"/"Drawn" (both imply competing for something) are the
// wrong words for it (user's explicit call, 2026-07-26). Reserve
// "players"/"Drawn" for raffle-style games with an actual winner
// (SingleWinner/Podium).
export function participantsWord(raffleType: string): string {
  return raffleType === "airdrop" ? "participants" : "players";
}

export function statusLabelKey(status: string, raffleType: string): string {
  if (status === "drawn" && raffleType === "airdrop") return "createYourOwnLuck.status.executed";
  return `createYourOwnLuck.status.${status}`;
}
