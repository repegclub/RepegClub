import { useCallback, useEffect, useState } from "react";
import { getRaffles, type RafflesResponse } from "../lib/queryFactory";
import { useLatestRequest } from "./useLatestRequest";

export type CyolRafflesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; raffles: RafflesResponse };

// Same shape as useWeeklyRound/useWheelRound - see useLatestRequest for the
// stale-response race it guards against.
export function useCyolRaffles(): CyolRafflesState & { refetch: () => void } {
  const [state, setState] = useState<CyolRafflesState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(async () => {
    const token = start();
    try {
      const raffles = await getRaffles();
      if (isCurrent(token)) setState({ status: "loaded", raffles });
    } catch (err) {
      if (isCurrent(token)) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        });
      }
    }
  }, [start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
