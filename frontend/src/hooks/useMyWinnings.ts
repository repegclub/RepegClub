import { useCallback, useEffect, useState } from "react";
import { getMyWinnings, type WinningEntry } from "../lib/queryWheelManager";
import { useLatestRequest } from "./useLatestRequest";

export type MyWinningsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; winnings: WinningEntry[] };

// wallet === null (not connected) intentionally skips the query rather than
// erroring - there's nothing to look up yet. `contractAddress` selects which
// tier to read - defaults to the single wired-up tier when omitted.
export function useMyWinnings(
  wallet: string | null,
  contractAddress?: string
): MyWinningsState & { refetch: () => void } {
  const [state, setState] = useState<MyWinningsState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    if (!wallet) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    getMyWinnings(wallet, contractAddress)
      .then((res) => {
        if (isCurrent(token)) setState({ status: "loaded", winnings: res.winnings });
      })
      .catch((err) => {
        if (isCurrent(token)) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Query failed.",
          });
        }
      });
  }, [wallet, contractAddress, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
