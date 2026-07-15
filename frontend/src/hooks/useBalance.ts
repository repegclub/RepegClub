import { useCallback, useEffect, useState } from "react";
import { getBalance } from "../lib/queryBalance";

export type BalanceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; amount: string };

// address/denom === null|undefined (not connected, or round config not
// loaded yet) intentionally skips the query rather than erroring.
export function useBalance(
  address: string | null,
  denom: string | undefined
): BalanceState & { refetch: () => void } {
  const [state, setState] = useState<BalanceState>({ status: "idle" });

  const load = useCallback(() => {
    if (!address || !denom) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    getBalance(address, denom)
      .then((amount) => setState({ status: "loaded", amount }))
      .catch((err) =>
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        })
      );
  }, [address, denom]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
