import { useCallback, useEffect, useState } from "react";
import { getAllBalances, type DenomBalance } from "../lib/queryBalance";
import { useLatestRequest } from "./useLatestRequest";

export type AllBalancesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; balances: DenomBalance[] };

// Same idle/loading/error/loaded shape and stale-response guard as
// useBalance.ts, but for TreasuryPanel.tsx's "every denom this address
// holds" query (getAllBalances) instead of one address+denom pair.
export function useAllBalances(address: string, lcd: string): AllBalancesState {
  const [state, setState] = useState<AllBalancesState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    setState({ status: "loading" });
    getAllBalances(address, lcd)
      .then((balances) => {
        if (isCurrent(token)) setState({ status: "loaded", balances });
      })
      .catch((err) => {
        if (isCurrent(token)) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Query failed.",
          });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, lcd]);

  useEffect(() => {
    load();
  }, [load]);

  return state;
}
