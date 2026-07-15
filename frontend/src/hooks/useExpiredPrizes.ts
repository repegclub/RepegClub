import { useCallback, useState } from "react";
import { getConfig, getCurrentRound, getRoundHistory } from "../lib/queryWheelManager";
import { getCurrentWeek, getWeekHistory, getWeeklyConfig } from "../lib/queryWeeklyRound";
import { WHEEL_MANAGER_ADDRESSES, WEEKLY_ROUND_ADDRESS } from "../lib/deployment";

// How many past rounds/weeks to look back per contract - an admin tool
// checked rarely (only when a support request comes in), so depth matters
// less than for the player-facing history panel; this is generous enough to
// cover months of activity at current volumes without scanning forever.
const SCAN_DEPTH = 90;

export type ExpiredPrizeEntry = {
  contractAddress: string;
  contractType: "wheel-manager" | "weekly-round";
  id: number; // round_id for wheel-manager, week_id for weekly-round
  amount: string;
  eligibleAtSeconds: number;
  eligibleNow: boolean;
};

async function scanWheelManagerTier(contractAddress: string): Promise<ExpiredPrizeEntry[]> {
  const [config, current] = await Promise.all([getConfig(contractAddress), getCurrentRound(contractAddress)]);
  const from = Math.max(1, current.round_id - SCAN_DEPTH);
  const ids: number[] = [];
  for (let id = current.round_id - 1; id >= from; id--) ids.push(id);
  const rounds = await Promise.all(ids.map((id) => getRoundHistory(id, contractAddress)));

  const nowSeconds = Math.floor(Date.now() / 1000);
  const entries: ExpiredPrizeEntry[] = [];
  for (const round of rounds) {
    const referenceTime = round.status === "drawn" ? round.drawn_at : round.status === "expired" ? round.expired_at : null;
    const amount = round.status === "drawn" ? round.prize_remaining : round.status === "expired" ? round.pool : "0";
    if (referenceTime === null || amount === "0") continue;
    const eligibleAtSeconds = referenceTime + config.unclaimed_deadline_days * 86400;
    entries.push({
      contractAddress,
      contractType: "wheel-manager",
      id: round.round_id,
      amount,
      eligibleAtSeconds,
      eligibleNow: nowSeconds >= eligibleAtSeconds,
    });
  }
  return entries;
}

async function scanWeeklyRound(contractAddress: string): Promise<ExpiredPrizeEntry[]> {
  const [config, current] = await Promise.all([getWeeklyConfig(contractAddress), getCurrentWeek(contractAddress)]);
  const from = Math.max(1, current.week_id - SCAN_DEPTH);
  const ids: number[] = [];
  for (let id = current.week_id - 1; id >= from; id--) ids.push(id);
  const weeks = await Promise.all(ids.map((id) => getWeekHistory(id, contractAddress)));

  const nowSeconds = Math.floor(Date.now() / 1000);
  const entries: ExpiredPrizeEntry[] = [];
  for (const week of weeks) {
    const referenceTime = week.status === "drawn" ? week.drawn_at : week.status === "expired" ? week.expired_at : null;
    const amount = week.status === "drawn" ? week.prize_remaining : week.status === "expired" ? week.pool : "0";
    if (referenceTime === null || amount === "0") continue;
    const eligibleAtSeconds = referenceTime + config.unclaimed_deadline_days * 86400;
    entries.push({
      contractAddress,
      contractType: "weekly-round",
      id: week.week_id,
      amount,
      eligibleAtSeconds,
      eligibleNow: nowSeconds >= eligibleAtSeconds,
    });
  }
  return entries;
}

export type ExpiredPrizesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; entries: ExpiredPrizeEntry[] };

export function useExpiredPrizes() {
  const [state, setState] = useState<ExpiredPrizesState>({ status: "idle" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    Promise.all([...WHEEL_MANAGER_ADDRESSES.map(scanWheelManagerTier), scanWeeklyRound(WEEKLY_ROUND_ADDRESS)])
      .then((results) => {
        const entries = results.flat().sort((a, b) => a.eligibleAtSeconds - b.eligibleAtSeconds);
        setState({ status: "loaded", entries });
      })
      .catch((err) =>
        setState({ status: "error", message: err instanceof Error ? err.message : "Query failed." })
      );
  }, []);

  return { state, load };
}
