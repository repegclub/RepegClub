import { useCallback, useEffect, useState } from "react";
import { getRoundEntrants } from "../lib/queryWheelManager";
import { colorForIndex, type Entrant } from "../lib/wheelData";

export type RoundEntrantsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; entrants: Entrant[] };

function truncateAddress(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 10)}...${addr.slice(-4)}` : addr;
}

// Aggregates the raw one-entry-per-ticket list from the contract into one
// row per unique wallet, in first-bought order (matches the order the mock
// data used to render in).
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

export function useRoundEntrants(
  roundId: number | null,
  contractAddress?: string
): RoundEntrantsState & { refetch: () => void } {
  const [state, setState] = useState<RoundEntrantsState>({ status: "loading" });

  const load = useCallback(() => {
    if (roundId === null) return;
    setState({ status: "loading" });
    getRoundEntrants(roundId, contractAddress)
      .then((res) => {
        setState({ status: "loaded", entrants: aggregate(res.entrants) });
      })
      .catch((err) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        });
      });
  }, [roundId, contractAddress]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
