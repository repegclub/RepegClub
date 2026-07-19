import { useCallback, useEffect, useState } from "react";
import { getMyWeeklyWinnings, type WeeklyWinningEntry } from "../lib/queryWeeklyRound";
import { useLatestRequest } from "./useLatestRequest";

export type MyWeeklyWinningsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; winnings: WeeklyWinningEntry[] };

export function useMyWeeklyWinnings(
  wallet: string | null,
  contractAddress?: string
): MyWeeklyWinningsState & { refetch: () => void } {
  const [state, setState] = useState<MyWeeklyWinningsState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    if (!wallet) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    getMyWeeklyWinnings(wallet, contractAddress)
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
