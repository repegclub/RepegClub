import { queryContract } from "@goblinhunt/cosmes/client";
import { RPC } from "./chainConfig";

// Mirrors contracts/weekly-round/src/state.rs - same RoundStatus enum shape
// as Wheel Manager's, just week-scoped instead of round-scoped.
export type WeeklyRoundStatus = "open" | "closed" | "drawn" | "expired";

// Only the fields ExpiredPrizesButton actually needs - the real contract
// response has more (ticket_sales_pool, wheel_contributions, today_price,
// etc.), left out here since nothing reads them yet.
export type WeekResponse = {
  week_id: number;
  status: WeeklyRoundStatus;
  pool: string;
  drawn_at: number | null;
  prize_remaining: string;
  expired_at: number | null;
};

export type WeeklyConfigResponse = {
  admin: string;
  unclaimed_deadline_days: number;
};

export function getCurrentWeek(contractAddress: string) {
  return queryContract<WeekResponse>(RPC, {
    address: contractAddress,
    query: { get_current_week: {} },
  });
}

export function getWeekHistory(weekId: number, contractAddress: string) {
  return queryContract<WeekResponse>(RPC, {
    address: contractAddress,
    query: { get_week_history: { week_id: weekId } },
  });
}

export function getWeeklyConfig(contractAddress: string) {
  return queryContract<WeeklyConfigResponse>(RPC, {
    address: contractAddress,
    query: { get_config: {} },
  });
}
