import { useCallback, useEffect, useState } from "react";
import { getRoundEntrants } from "../lib/queryWheelManager";
import { WHEEL_MANAGER_ADDRESS } from "../lib/deployment";
import { openSource, wheelSource } from "./useWalletHistory";
import { useLatestRequest } from "./useLatestRequest";

export type RefundEntry = { round_id: number; ticket_count: number };

export type MyRefundsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  // `key` (wallet + contract) lets a plain refetch keep showing the current
  // list instead of blanking it, while a wallet/tier switch still resets.
  | { status: "loaded"; refunds: RefundEntry[]; key: string };

// Expired rounds this wallet already reclaimed - ReclaimTicket removes the
// wallet from that round's entrants for good, so once seen gone it never
// needs re-checking. Keeps a wallet that has let many rounds expire from
// re-querying every one of them on each page load.
function reclaimedKey(contractAddress: string, wallet: string): string {
  return `repegclub:reclaimed:${contractAddress}:${wallet}`;
}

function loadReclaimed(contractAddress: string, wallet: string): number[] {
  try {
    const raw = localStorage.getItem(reclaimedKey(contractAddress, wallet));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function saveReclaimed(contractAddress: string, wallet: string, roundIds: number[]): void {
  try {
    localStorage.setItem(reclaimedKey(contractAddress, wallet), JSON.stringify(roundIds));
  } catch {
    // Same as historyCache - unavailable storage just means re-checking.
  }
}

// Past expired rounds where this wallet still has ticket money waiting -
// before this, the only way to find one was the "Check round #N" button,
// which only reaches the round right before the current one, and only if
// the player knew to look. Reuses Wallet History's incremental scan (and
// its localStorage cache), then re-checks each expired round's live
// entrants, since the cached entry only says the wallet played it, not
// whether it has reclaimed since. `currentRoundId` is a dependency so a
// round the keeper just expired gets picked up as soon as the page moves on.
// Known limit, accepted on purpose (PR #60): a browser with no cache only
// scans the last 30 rounds (openSource's DEFAULT_DEPTH), so a refund older
// than that wouldn't show here - scanning full history on first visit would
// cost 2 public-RPC queries per round ever played. Revisit if round counts
// grow enough for that to matter.
export function useMyRefunds(
  wallet: string | null,
  contractAddress: string | undefined,
  currentRoundId: number | null
): MyRefundsState & { refetch: () => void } {
  const [state, setState] = useState<MyRefundsState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();
  const address = contractAddress ?? WHEEL_MANAGER_ADDRESS;

  const load = useCallback(async () => {
    const token = start();
    if (!wallet || currentRoundId === null) {
      setState({ status: "idle" });
      return;
    }
    const key = `${wallet}:${address}`;
    setState((prev) => (prev.status === "loaded" && prev.key === key ? prev : { status: "loading" }));
    try {
      const { entries } = await openSource(wheelSource(address), wallet);
      const reclaimed = loadReclaimed(address, wallet);
      const candidates = entries.filter((e) => e.status === "expired" && !reclaimed.includes(e.round_id));
      const checked = await Promise.all(
        candidates.map(async (e) => {
          const res = await getRoundEntrants(e.round_id, address);
          return { round_id: e.round_id, ticket_count: res.entrants.filter((a) => a === wallet).length };
        })
      );
      const nowReclaimed = checked.filter((c) => c.ticket_count === 0).map((c) => c.round_id);
      if (nowReclaimed.length > 0) saveReclaimed(address, wallet, [...reclaimed, ...nowReclaimed]);
      if (isCurrent(token)) {
        setState({
          status: "loaded",
          refunds: checked.filter((c) => c.ticket_count > 0).sort((a, b) => b.round_id - a.round_id),
          key,
        });
      }
    } catch (err) {
      if (isCurrent(token)) {
        setState({ status: "error", message: err instanceof Error ? err.message : "Query failed." });
      }
    }
  }, [wallet, address, currentRoundId, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
