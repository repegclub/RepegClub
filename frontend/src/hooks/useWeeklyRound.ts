import { useCallback, useEffect, useState } from "react";
import {
  getCurrentWeek,
  getWeeklyConfig,
  getWeekHistory,
  type WeekResponse,
  type WeeklyConfigResponse,
} from "../lib/queryWeeklyRound";
import { useLatestRequest } from "./useLatestRequest";

export type WeeklyRoundState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; week: WeekResponse; config: WeeklyConfigResponse };

// Same shape as useWheelRound - see that file for the full rationale on the
// weekId-pinning behavior (DrawWeeklyWinner advances the contract's "current
// week" the same way DrawWinner does for rounds).
export function useWeeklyRound(
  weekId?: number,
  contractAddress?: string
): WeeklyRoundState & { refetch: () => void } {
  const [state, setState] = useState<WeeklyRoundState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(async () => {
    const token = start();
    try {
      const [week, config] = await Promise.all([
        weekId !== undefined ? getWeekHistory(weekId, contractAddress) : getCurrentWeek(contractAddress),
        getWeeklyConfig(contractAddress),
      ]);
      if (isCurrent(token)) setState({ status: "loaded", week, config });
    } catch (err) {
      if (isCurrent(token)) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        });
      }
    }
  }, [weekId, contractAddress, start, isCurrent]);

  useEffect(() => {
    setState({ status: "loading" });
    load();
  }, [load]);

  return { ...state, refetch: load };
}
