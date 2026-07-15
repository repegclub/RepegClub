import { useCallback, useEffect, useState } from "react";
import {
  getCurrentRound,
  getConfig,
  getRoundHistory,
  type WheelRoundResponse,
  type WheelConfigResponse,
} from "../lib/queryWheelManager";

export type WheelRoundState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; round: WheelRoundResponse; config: WheelConfigResponse };

// If `roundId` is given, always fetches that specific round (used to keep
// showing a round that was just drawn, since DrawWinner immediately
// advances the contract's own "current round" to a fresh one). Otherwise
// follows whatever the contract reports as current. `contractAddress`
// selects which tier to read - defaults to queryWheelManager's own default
// (the single wired-up tier) when omitted, so existing single-tier callers
// don't need to change.
export function useWheelRound(
  roundId?: number,
  contractAddress?: string
): WheelRoundState & { refetch: () => void } {
  const [state, setState] = useState<WheelRoundState>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      const [round, config] = await Promise.all([
        roundId !== undefined ? getRoundHistory(roundId, contractAddress) : getCurrentRound(contractAddress),
        getConfig(contractAddress),
      ]);
      setState({ status: "loaded", round, config });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Query failed.",
      });
    }
  }, [roundId, contractAddress]);

  useEffect(() => {
    // Reset to loading immediately when what we're fetching changes (a
    // different round or tier) - otherwise the PREVIOUS tier's config
    // (ticket price/denom) stays on screen, and stays actionable (e.g. Buy
    // Ticket), until the new tier's data arrives, letting a fast click send
    // the old tier's price/denom to the new tier's contract and fail. A
    // plain refetch() of the same round/tier (e.g. after a purchase) calls
    // `load` directly instead of going through this effect, so it doesn't
    // cause a loading-flash regression for that already-working case.
    setState({ status: "loading" });
    load();
  }, [load]);

  return { ...state, refetch: load };
}
