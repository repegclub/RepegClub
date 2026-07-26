import { useEffect, useState } from "react";
import { fetchTokenPrices, type TokenPrices } from "../lib/tokenPrices";

export type TokenPricesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; prices: TokenPrices };

// One-shot fetch, no polling - unlike the on-chain checklist signals (which
// can genuinely change while a page stays open), real-world token prices
// don't need to be live for a single buy/fund decision. Failure is
// deliberately silent to the caller (status: "error") rather than thrown -
// this only ever informs a warning, never gates the transaction itself, so
// callers should just skip the warning if prices aren't available.
export function useTokenPrices(): TokenPricesState {
  const [state, setState] = useState<TokenPricesState>({ status: "loading" });

  useEffect(() => {
    let current = true;
    fetchTokenPrices()
      .then((prices) => {
        if (current) setState({ status: "loaded", prices });
      })
      .catch(() => {
        if (current) setState({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, []);

  return state;
}
