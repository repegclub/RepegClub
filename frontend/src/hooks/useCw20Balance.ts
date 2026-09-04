import { useCallback, useEffect, useState } from "react";
import { getCw20Balance } from "../lib/queryCw20";
import { useLatestRequest } from "./useLatestRequest";

export type Cw20BalanceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; amount: string };

// Mirrors useBalance.ts's shape/guard exactly, but for a CW20 token balance
// (queryCw20.ts) instead of a bank-module denom - see onrampConfig.ts's
// HyperlaneCw20Warp for why LUNC/USTC's useBalance doesn't cover this.
// address/tokenContract === null intentionally skips the query, same
// "disable via null arg" pattern DirectTransferCard.tsx already uses for
// useBalance (e.g. gasIsSameDenom).
export function useCw20Balance(
  address: string | null,
  tokenContract: string | null,
  rpc: string
): Cw20BalanceState & { refetch: () => void } {
  const [state, setState] = useState<Cw20BalanceState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const token = start();
    if (!address || !tokenContract) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    getCw20Balance(address, tokenContract, rpc)
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
  }, [address, tokenContract, rpc, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
