import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { quoteEvmInbound, readEvmBalances, type EvmInboundQuote } from "../lib/evmOnramp";
import type { EvmChainParams } from "../lib/onrampConfig";
import { useLatestRequest } from "./useLatestRequest";

export type EvmBalancesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; token: bigint; native: bigint };

// Token + native-coin balance of `owner` on the chain, from our own RPC.
// Same shape/guard as useCw20Balance.ts; null token/owner skips the query.
export function useEvmBalances(
  params: EvmChainParams,
  token: Hex | null,
  owner: Hex | null
): EvmBalancesState & { refetch: () => void } {
  const [state, setState] = useState<EvmBalancesState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const req = start();
    if (!token || !owner) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    readEvmBalances(params, token, owner)
      .then((b) => {
        if (isCurrent(req)) setState({ status: "loaded", token: b.token, native: b.native });
      })
      .catch((err) => {
        if (isCurrent(req)) {
          setState({ status: "error", message: err instanceof Error ? err.message : "Balance query failed." });
        }
      });
  }, [params, token, owner, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}

export type EvmQuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | ({ status: "loaded"; amount: bigint } & EvmInboundQuote);

// Neither the interchain gas nor the route fee depends on who receives, so
// the on-screen quote uses an all-zero recipient and can show before an
// address is typed. sendEvmToTerraClassic re-quotes with the real one right
// before signing. `amount` is echoed back in the loaded state so the form
// can tell a quote for what's typed now from one for a previous value.
const QUOTE_RECIPIENT: Hex = `0x${"00".repeat(32)}`;

export function useEvmInboundQuote(
  params: EvmChainParams,
  token: Hex | null,
  amount: bigint
): EvmQuoteState & { refetch: () => void } {
  const [state, setState] = useState<EvmQuoteState>({ status: "idle" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(() => {
    const req = start();
    if (!token || amount <= 0n) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    quoteEvmInbound(params, token, QUOTE_RECIPIENT, amount)
      .then((q) => {
        if (isCurrent(req)) setState({ status: "loaded", amount, ...q });
      })
      .catch((err) => {
        if (isCurrent(req)) {
          setState({ status: "error", message: err instanceof Error ? err.message : "Quote failed." });
        }
      });
  }, [params, token, amount, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
