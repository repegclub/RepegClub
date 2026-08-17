import { useCallback, useEffect, useState } from "react";
import { getBalance } from "../lib/queryBalance";
import { useLatestRequest } from "./useLatestRequest";

export type BalanceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; amount: string };

// address/denom === null|undefined (not connected, or round config not
// loaded yet) intentionally skips the query rather than erroring. `lcd`
// defaults to this project's usual (testnet Terra Classic) endpoint - the
// onramp's Noble balance check is the only caller that overrides it.
export function useBalance(
  address: string | null,
  denom: string | undefined,
  lcd?: string
): BalanceState & { refetch: () => void } {
  const [state, setState] = useState<BalanceState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    if (!address || !denom) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    getBalance(address, denom, lcd)
      .then((amount) => {
        if (isCurrent(token)) setState({ status: "loaded", amount });
      })
      .catch((err) => {
        if (isCurrent(token)) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Query failed.",
          });
        }
      });
  }, [address, denom, lcd, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
