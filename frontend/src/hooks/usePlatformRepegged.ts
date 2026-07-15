import { useCallback, useEffect, useState } from "react";
import { getCurrentRound, getRoundHistory, getWalletStats } from "../lib/queryWheelManager";
import { WHEEL_MANAGER_ADDRESSES } from "../lib/deployment";
import { loadWinnersCache, saveWinnersCache } from "../lib/platformRepeggedCache";

const CONCURRENCY = 15;

export type PlatformRepeggedState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; totalRedeemed: string };

// No contract-side global counter exists for "total ever redeemed across
// every wallet" (only a per-wallet one, via GetWalletStats) - rather than
// add one (which would mean a contract redeploy), this derives the exact
// same number client-side: only a round's *winner* can ever have a nonzero
// total_redeemed, so scanning drawn rounds for their `winner` field finds
// every wallet that could possibly contribute, then GetWalletStats gives
// each one's real, exact redeemed total. Same incremental-cursor caching
// approach as useWalletHistory, just collecting winners instead of a single
// wallet's own rounds.
async function findWinners(contractAddress: string, roundIds: number[]): Promise<string[]> {
  const winners: string[] = [];
  for (let i = 0; i < roundIds.length; i += CONCURRENCY) {
    const batch = roundIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((id) => getRoundHistory(id, contractAddress)));
    for (const round of results) {
      if (round.status === "drawn" && round.winner) winners.push(round.winner);
    }
  }
  return winners;
}

export function usePlatformRepegged(): PlatformRepeggedState & { refetch: () => void } {
  const [state, setState] = useState<PlatformRepeggedState>({ status: "loading" });
  // Bumped to force a fresh scan (e.g. right after a redeem changes a
  // winner's total_redeemed) - this hook has no wallet/round argument of its
  // own to depend on, unlike the other query hooks in this app.
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        let total = 0n;
        for (const contractAddress of WHEEL_MANAGER_ADDRESSES) {
          const cached = loadWinnersCache(contractAddress);
          const current = await getCurrentRound(contractAddress);
          const newestResolvable = current.round_id - 1;
          const winners = new Set(cached?.winners ?? []);
          let newestScanned = cached?.newestScanned ?? 0;

          if (newestResolvable > newestScanned) {
            const ids: number[] = [];
            for (let id = newestScanned + 1; id <= newestResolvable; id++) ids.push(id);
            const found = await findWinners(contractAddress, ids);
            for (const w of found) winners.add(w);
            newestScanned = newestResolvable;
            saveWinnersCache(contractAddress, {
              newestScanned,
              winners: Array.from(winners),
            });
          }

          const stats = await Promise.all(
            Array.from(winners).map((wallet) => getWalletStats(wallet, contractAddress))
          );
          for (const s of stats) total += BigInt(s.total_redeemed);
        }
        if (!cancelled) setState({ status: "loaded", totalRedeemed: total.toString() });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Query failed.",
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return { ...state, refetch };
}
