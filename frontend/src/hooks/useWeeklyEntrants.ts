import { useCallback, useEffect, useState } from "react";
import { getWeekEntrants } from "../lib/queryWeeklyRound";
import { colorForIndex, type Entrant } from "../lib/wheelData";

export type WeeklyEntrantsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; entrants: Entrant[] };

function truncateAddress(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 10)}...${addr.slice(-4)}` : addr;
}

// Same aggregation as useRoundEntrants - one row per unique wallet, in
// first-bought order.
function aggregate(rawEntrants: string[]): Entrant[] {
  const counts = new Map<string, number>();
  for (const addr of rawEntrants) {
    counts.set(addr, (counts.get(addr) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([address, tickets], i) => ({
    name: truncateAddress(address),
    address,
    tickets,
    color: colorForIndex(i),
  }));
}

export function useWeeklyEntrants(
  weekId: number | null,
  contractAddress?: string
): WeeklyEntrantsState & { refetch: () => void } {
  const [state, setState] = useState<WeeklyEntrantsState>({ status: "loading" });

  const load = useCallback(() => {
    if (weekId === null) return;
    setState({ status: "loading" });
    getWeekEntrants(weekId, contractAddress)
      .then((res) => {
        setState({ status: "loaded", entrants: aggregate(res.entrants) });
      })
      .catch((err) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        });
      });
  }, [weekId, contractAddress]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
