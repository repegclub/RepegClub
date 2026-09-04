import { useCallback, useEffect, useState } from "react";
import { quoteHyperlaneGasFee } from "../lib/queryHyperlaneGas";
import { useLatestRequest } from "./useLatestRequest";

export type HyperlaneGasFeeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; amountUluna: bigint };

// Mirrors useCw20Balance.ts's shape/guard exactly, but for the live
// interchain gas quote (queryHyperlaneGas.ts) instead of a balance -
// re-fetches whenever the asset/destination pair changes (warpContract or
// destDomain), same "disable via null arg" pattern for a not-yet-selected
// destination.
export function useHyperlaneGasFee(
  warpContract: string | null,
  destDomain: number | null,
  rpc: string
): HyperlaneGasFeeState & { refetch: () => void } {
  const [state, setState] = useState<HyperlaneGasFeeState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    if (!warpContract || destDomain === null) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    quoteHyperlaneGasFee(rpc, warpContract, destDomain)
      .then((amountUluna) => {
        if (isCurrent(token)) setState({ status: "loaded", amountUluna });
      })
      .catch((err) => {
        if (isCurrent(token)) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Gas quote failed.",
          });
        }
      });
  }, [warpContract, destDomain, rpc, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
