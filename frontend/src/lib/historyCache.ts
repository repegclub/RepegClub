export type HistoryEntry = {
  round_id: number;
  // Which tier this round belongs to - round_ids repeat across tiers (every
  // tier has its own round #1), so this is needed to tell entries apart
  // once history spans more than one tier.
  contractAddress: string;
  status: string;
  // This wallet's own ticket count in that round (not the round's total).
  ticket_count: number;
  won: boolean;
  // The prize actually won (pool * PRIZE_SHARE at draw time) - NOT
  // `prize_remaining`, which drops to 0 once fully redeemed and would make
  // a wallet's own past win look like it won nothing.
  prize_amount: string;
};

export type CachedHistory = {
  // Highest round_id already scanned - a later visit only needs to scan
  // rounds above this, not redo the whole history every time.
  newestScanned: number;
  // Lowest round_id scanned so far - "load older rounds" continues from
  // just below this instead of rescanning what's already cached.
  oldestScanned: number;
  entries: HistoryEntry[];
};

// Bump this whenever HistoryEntry's shape changes - a stale cache written
// under an older shape (e.g. before prize_remaining was replaced with
// prize_amount) would otherwise get read back with the new code and produce
// garbage (NaN amounts) instead of just being treated as "no cache yet".
const CACHE_VERSION = 3;

type StoredCache = CachedHistory & { version: number };

function cacheKey(contractAddress: string, wallet: string): string {
  return `repegclub:history:${contractAddress}:${wallet}`;
}

export function loadHistoryCache(contractAddress: string, wallet: string): CachedHistory | null {
  try {
    const raw = localStorage.getItem(cacheKey(contractAddress, wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCache;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveHistoryCache(contractAddress: string, wallet: string, data: CachedHistory): void {
  try {
    const stored: StoredCache = { ...data, version: CACHE_VERSION };
    localStorage.setItem(cacheKey(contractAddress, wallet), JSON.stringify(stored));
  } catch {
    // localStorage can be unavailable (private browsing, quota) - the
    // history feature just degrades to "re-scan every time", not a hard
    // failure, so this is deliberately swallowed.
  }
}
