import { useCallback, useEffect, useState } from "react";
import { getMyWeeklyWinnings, type WeeklyWinningEntry } from "../lib/queryWeeklyRound";

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

  const load = useCallback(() => {
    if (!wallet) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    getMyWeeklyWinnings(wallet, contractAddress)
      .then((res) => setState({ status: "loaded", winnings: res.winnings }))
      .catch((err) =>
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        })
      );
  }, [wallet, contractAddress]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
