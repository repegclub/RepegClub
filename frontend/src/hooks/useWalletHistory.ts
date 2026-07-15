import { useCallback, useState } from "react";
import { getCurrentRound, getRoundHistory, getRoundEntrants, PRIZE_SHARE } from "../lib/queryWheelManager";
import { WHEEL_MANAGER_ADDRESSES } from "../lib/deployment";
import { loadHistoryCache, saveHistoryCache, type HistoryEntry } from "../lib/historyCache";

// First-ever scan for a wallet only looks this many rounds back per tier,
// so opening the history panel for the first time (potentially against
// contracts with hundreds of past rounds) stays fast - "load older rounds"
// continues from there on demand. Once cached, later visits only ever scan
// rounds newer than what's already stored, per tier.
const DEFAULT_DEPTH = 30;
// Round-scans run in parallel batches (2 queries each - round + entrants)
// rather than one at a time, which is what actually keeps this fast; a
// sequential scan of even 20 rounds would be visibly slow.
const CONCURRENCY = 15;

export type WalletHistoryState =
  | { status: "idle" }
  | { status: "loading"; entries: HistoryEntry[] }
  | { status: "error"; message: string; entries: HistoryEntry[] }
  | { status: "loaded"; entries: HistoryEntry[]; hasMore: boolean };

async function scanRounds(
  contractAddress: string,
  roundIds: number[],
  wallet: string
): Promise<HistoryEntry[]> {
  const found: HistoryEntry[] = [];
  for (let i = 0; i < roundIds.length; i += CONCURRENCY) {
    const batch = roundIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (roundId) => {
        const [round, entrantsRes] = await Promise.all([
          getRoundHistory(roundId, contractAddress),
          getRoundEntrants(roundId, contractAddress),
        ]);
        const ticketCount = entrantsRes.entrants.filter((a) => a === wallet).length;
        if (ticketCount === 0) return null;
        // round.pool never changes after a round is closed (only
        // prize_remaining is decremented as the winner redeems), so this
        // stays accurate forever - unlike prize_remaining, which would read
        // as "won 0" once fully redeemed.
        const prizeAmount = (BigInt(round.pool) * BigInt(Math.round(PRIZE_SHARE * 100))) / 100n;
        const entry: HistoryEntry = {
          round_id: roundId,
          contractAddress,
          status: round.status,
          ticket_count: ticketCount,
          won: round.winner === wallet,
          prize_amount: prizeAmount.toString(),
        };
        return entry;
      })
    );
    for (const entry of results) if (entry) found.push(entry);
  }
  return found;
}

// Catches ONE tier up to its current round - same incremental cursor
// approach as before, just scoped to a single contract so it can be run for
// every deployed tier and merged into one combined, platform-wide history
// (matching the scope of the lifetime-stats totals it sits next to).
async function openTier(contractAddress: string, wallet: string) {
  const cached = loadHistoryCache(contractAddress, wallet);
  const current = await getCurrentRound(contractAddress);
  const newestResolvable = current.round_id - 1;
  if (newestResolvable < 1) {
    return { entries: cached?.entries ?? [], hasMore: false };
  }

  let entries = cached?.entries ?? [];
  let newestScanned = cached?.newestScanned ?? 0;
  let oldestScanned = cached?.oldestScanned ?? newestResolvable + 1;

  if (newestResolvable > newestScanned) {
    const from = cached ? newestScanned + 1 : Math.max(1, newestResolvable - DEFAULT_DEPTH + 1);
    const ids: number[] = [];
    for (let id = newestResolvable; id >= from; id--) ids.push(id);
    const found = await scanRounds(contractAddress, ids, wallet);
    entries = [...found, ...entries];
    newestScanned = newestResolvable;
    if (!cached) oldestScanned = from;
    saveHistoryCache(contractAddress, wallet, { newestScanned, oldestScanned, entries });
  }

  return { entries, hasMore: oldestScanned > 1 };
}

async function loadMoreTier(contractAddress: string, wallet: string) {
  const cached = loadHistoryCache(contractAddress, wallet);
  if (!cached || cached.oldestScanned <= 1) {
    return { entries: cached?.entries ?? [], hasMore: false };
  }
  const to = Math.max(1, cached.oldestScanned - DEFAULT_DEPTH);
  const ids: number[] = [];
  for (let id = cached.oldestScanned - 1; id >= to; id--) ids.push(id);
  const found = await scanRounds(contractAddress, ids, wallet);
  const entries = [...cached.entries, ...found];
  const oldestScanned = to;
  saveHistoryCache(contractAddress, wallet, {
    newestScanned: cached.newestScanned,
    oldestScanned,
    entries,
  });
  return { entries, hasMore: oldestScanned > 1 };
}

export function useWalletHistory(wallet: string | null) {
  const [state, setState] = useState<WalletHistoryState>({ status: "idle" });

  const open = useCallback(async () => {
    if (!wallet) return;
    const cachedEntries = WHEEL_MANAGER_ADDRESSES.flatMap(
      (address) => loadHistoryCache(address, wallet)?.entries ?? []
    );
    setState({ status: "loading", entries: cachedEntries });
    try {
      const results = await Promise.all(WHEEL_MANAGER_ADDRESSES.map((a) => openTier(a, wallet)));
      setState({
        status: "loaded",
        entries: results.flatMap((r) => r.entries),
        hasMore: results.some((r) => r.hasMore),
      });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Query failed.",
        entries: cachedEntries,
      });
    }
  }, [wallet]);

  const loadMore = useCallback(async () => {
    if (!wallet) return;
    setState((prev) => ({ status: "loading", entries: prev.status === "idle" ? [] : prev.entries }));
    try {
      const results = await Promise.all(WHEEL_MANAGER_ADDRESSES.map((a) => loadMoreTier(a, wallet)));
      setState({
        status: "loaded",
        entries: results.flatMap((r) => r.entries),
        hasMore: results.some((r) => r.hasMore),
      });
    } catch (err) {
      setState((prev) => ({
        status: "error",
        message: err instanceof Error ? err.message : "Query failed.",
        entries: prev.status === "idle" ? [] : prev.entries,
      }));
    }
  }, [wallet]);

  return { state, open, loadMore };
}
