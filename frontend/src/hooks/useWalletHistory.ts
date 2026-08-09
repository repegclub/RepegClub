import { useCallback, useState } from "react";
import { getCurrentRound, getRoundHistory, getRoundEntrants, PRIZE_SHARE } from "../lib/queryWheelManager";
import { getCurrentWeek, getWeekHistory, getWeekEntrants, WEEKLY_PRIZE_SHARE } from "../lib/queryWeeklyRound";
import { WHEEL_MANAGER_ADDRESSES, WEEKLY_ROUND_ADDRESS } from "../lib/deployment";
import { loadHistoryCache, saveHistoryCache, type HistoryEntry } from "../lib/historyCache";

// First-ever scan for a wallet only looks this many rounds back per source,
// so opening the history panel for the first time (potentially against
// contracts with hundreds of past rounds) stays fast - "load older rounds"
// continues from there on demand. Once cached, later visits only ever scan
// rounds newer than what's already stored, per source.
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

// Wheel Manager (round_id) and Weekly Round (week_id) have near-identical
// query shapes (get-current/get-history-by-id/get-entrants-by-id, plus a
// prize share) - this lets one scan implementation cover both instead of
// duplicating it. HistoryEntry.round_id doubles as "period id" for either
// (see historyCache.ts) rather than adding a week_id field just for this.
type HistorySource = {
  contractAddress: string;
  getCurrentId: () => Promise<number>;
  getPeriod: (id: number) => Promise<{ status: string; pool: string; winner: string | null }>;
  getEntrants: (id: number) => Promise<{ entrants: string[] }>;
  prizeShare: number;
};

function wheelSource(contractAddress: string): HistorySource {
  return {
    contractAddress,
    getCurrentId: async () => (await getCurrentRound(contractAddress)).round_id,
    getPeriod: (id) => getRoundHistory(id, contractAddress),
    getEntrants: (id) => getRoundEntrants(id, contractAddress),
    prizeShare: PRIZE_SHARE,
  };
}

function weeklySource(contractAddress: string): HistorySource {
  return {
    contractAddress,
    getCurrentId: async () => (await getCurrentWeek(contractAddress)).week_id,
    getPeriod: (id) => getWeekHistory(id, contractAddress),
    getEntrants: (id) => getWeekEntrants(id, contractAddress),
    prizeShare: WEEKLY_PRIZE_SHARE,
  };
}

// Every Wheel Manager tier plus the single platform-wide Weekly Round -
// wallet history is account-level, not tied to whichever game's page
// happens to be open (same reasoning as the platform-wide lifetime stats
// this panel sits next to).
const SOURCES: HistorySource[] = [...WHEEL_MANAGER_ADDRESSES.map(wheelSource), weeklySource(WEEKLY_ROUND_ADDRESS)];

async function scanRounds(source: HistorySource, roundIds: number[], wallet: string): Promise<HistoryEntry[]> {
  const found: HistoryEntry[] = [];
  for (let i = 0; i < roundIds.length; i += CONCURRENCY) {
    const batch = roundIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (roundId) => {
        const [round, entrantsRes] = await Promise.all([source.getPeriod(roundId), source.getEntrants(roundId)]);
        const ticketCount = entrantsRes.entrants.filter((a) => a === wallet).length;
        if (ticketCount === 0) return null;
        // round.pool never changes after a round is closed (only
        // prize_remaining is decremented as the winner redeems), so this
        // stays accurate forever - unlike prize_remaining, which would read
        // as "won 0" once fully redeemed.
        const prizeAmount = (BigInt(round.pool) * BigInt(Math.round(source.prizeShare * 100))) / 100n;
        const entry: HistoryEntry = {
          round_id: roundId,
          contractAddress: source.contractAddress,
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

// Catches ONE source up to its current round - same incremental cursor
// approach as before, just scoped to a single contract so it can be run for
// every deployed tier (and Weekly Round) and merged into one combined,
// platform-wide history (matching the scope of the lifetime-stats totals it
// sits next to).
async function openSource(source: HistorySource, wallet: string) {
  const cached = loadHistoryCache(source.contractAddress, wallet);
  const currentId = await source.getCurrentId();
  const newestResolvable = currentId - 1;
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
    const found = await scanRounds(source, ids, wallet);
    entries = [...found, ...entries];
    newestScanned = newestResolvable;
    if (!cached) oldestScanned = from;
    saveHistoryCache(source.contractAddress, wallet, { newestScanned, oldestScanned, entries });
  }

  return { entries, hasMore: oldestScanned > 1 };
}

async function loadMoreSource(source: HistorySource, wallet: string) {
  const cached = loadHistoryCache(source.contractAddress, wallet);
  if (!cached || cached.oldestScanned <= 1) {
    return { entries: cached?.entries ?? [], hasMore: false };
  }
  const to = Math.max(1, cached.oldestScanned - DEFAULT_DEPTH);
  const ids: number[] = [];
  for (let id = cached.oldestScanned - 1; id >= to; id--) ids.push(id);
  const found = await scanRounds(source, ids, wallet);
  const entries = [...cached.entries, ...found];
  const oldestScanned = to;
  saveHistoryCache(source.contractAddress, wallet, {
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
    const cachedEntries = SOURCES.flatMap((s) => loadHistoryCache(s.contractAddress, wallet)?.entries ?? []);
    setState({ status: "loading", entries: cachedEntries });
    try {
      const results = await Promise.all(SOURCES.map((s) => openSource(s, wallet)));
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
      const results = await Promise.all(SOURCES.map((s) => loadMoreSource(s, wallet)));
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
