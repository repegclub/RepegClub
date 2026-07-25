import { useCallback, useEffect, useState } from "react";
import { getRoundEntrants } from "../lib/queryWheelManager";
import { aggregateEntrants, type Entrant } from "../lib/wheelData";
import { useLatestRequest } from "./useLatestRequest";

export type RoundEntrantsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; entrants: Entrant[] };

export function useRoundEntrants(
  roundId: number | null,
  contractAddress?: string
): RoundEntrantsState & { refetch: () => void } {
  const [state, setState] = useState<RoundEntrantsState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    if (roundId === null) return;
    setState({ status: "loading" });
    getRoundEntrants(roundId, contractAddress)
      .then((res) => {
        if (isCurrent(token)) setState({ status: "loaded", entrants: aggregateEntrants(res.entrants) });
      })
      .catch((err) => {
        if (isCurrent(token)) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Query failed.",
          });
        }
      });
  }, [roundId, contractAddress, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
