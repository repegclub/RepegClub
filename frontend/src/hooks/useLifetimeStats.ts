import { useCallback, useEffect, useState } from "react";
import { getWalletStats } from "../lib/queryWheelManager";
import { WHEEL_MANAGER_ADDRESSES, WEEKLY_ROUND_ADDRESS } from "../lib/deployment";

export type LifetimeStatsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; totalInvested: string; totalRedeemed: string };

// Sums GetWalletStats across every deployed contract this frontend knows
// about (every Wheel Manager tier + the single platform-wide Weekly Round) -
// "how much have I invested" / "how much USTC have I repegged" are meant to
// read as whole-platform totals, not per-tier ones.
export function useLifetimeStats(wallet: string | null): LifetimeStatsState & { refetch: () => void } {
  const [state, setState] = useState<LifetimeStatsState>({ status: "idle" });

  const load = useCallback(() => {
    if (!wallet) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const addresses = [...WHEEL_MANAGER_ADDRESSES, WEEKLY_ROUND_ADDRESS];
    Promise.all(addresses.map((address) => getWalletStats(wallet, address)))
      .then((results) => {
        let totalInvested = 0n;
        let totalRedeemed = 0n;
        for (const res of results) {
          totalInvested += BigInt(res.total_invested);
          totalRedeemed += BigInt(res.total_redeemed);
        }
        setState({
          status: "loaded",
          totalInvested: totalInvested.toString(),
          totalRedeemed: totalRedeemed.toString(),
        });
      })
      .catch((err) =>
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        })
      );
  }, [wallet]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
