export type WinnersCache = {
  // Highest round_id already scanned for winners - later visits only scan
  // rounds above this instead of rescanning the whole history every time.
  newestScanned: number;
  winners: string[];
};

function cacheKey(contractAddress: string): string {
  return `repegclub:winners:${contractAddress}`;
}

export function loadWinnersCache(contractAddress: string): WinnersCache | null {
  try {
    const raw = localStorage.getItem(cacheKey(contractAddress));
    if (!raw) return null;
    return JSON.parse(raw) as WinnersCache;
  } catch {
    return null;
  }
}

export function saveWinnersCache(contractAddress: string, data: WinnersCache): void {
  try {
    localStorage.setItem(cacheKey(contractAddress), JSON.stringify(data));
  } catch {
    // localStorage can be unavailable - degrades to rescanning every time.
  }
}
