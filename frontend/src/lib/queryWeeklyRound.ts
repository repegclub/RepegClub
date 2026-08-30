import { queryContract } from "@goblinhunt/cosmes/client";
import { RPC } from "./chainConfig";
import { WEEKLY_ROUND_ADDRESS } from "./deployment";

// Mirrors contracts/weekly-round/src/state.rs - same RoundStatus enum shape
// as Wheel Manager's, just week-scoped instead of round-scoped.
export type WeeklyRoundStatus = "open" | "closed" | "expiry_pending" | "drawn" | "expired";

export type WeekResponse = {
  week_id: number;
  status: WeeklyRoundStatus;
  ticket_count: number;
  unique_player_count: number;
  // The two sources that make up `pool` - kept separate so the UI can show
  // the jackpot as genuinely fed by every Wheel of Repeg round, not just
  // ticket sales for this week.
  ticket_sales_pool: string;
  wheel_contributions: string;
  pool: string;
  today_price: string;
  opened_at: number;
  closed_at: number | null;
  seconds_remaining: number;
  closed_at_height: number | null;
  drawn_at: number | null;
  // The hash this week must be revealed against (hex).
  commit_used: string | null;
  // The secret that unlocked commit_used (hex), once revealed - lets anyone
  // independently recompute pick_winner_index and check it against winner.
  // See lib/verifyWeeklyRound.ts.
  revealed_preimage: string | null;
  winner: string | null;
  prize_remaining: string;
  expired_at: number | null;
};

export type WeeklyConfigResponse = {
  admin: string;
  base_ticket_price: string;
  price_increment_per_day: string;
  ticket_denom: string;
  redemption_denom: string;
  min_players: number;
  max_players: number;
  round_duration_days: number;
  unclaimed_deadline_days: number;
  // How long a Closed week can go unrevealed before the 3-phase outage
  // expiration becomes callable - see lib/roundActions.ts.
  max_reveal_age_seconds: number;
  treasury_address: string;
  admin_fee_address: string;
  commit_pusher: string;
};

export function getCurrentWeek(contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return queryContract<WeekResponse>(RPC, {
    address: contractAddress,
    query: { get_current_week: {} },
  });
}

// Fetches a specific week by ID rather than whatever's currently open -
// needed because DrawWeeklyWinner immediately advances the contract's
// "current week" to a fresh empty one in the same tx, same reason Wheel
// Manager needs GetRoundHistory.
export function getWeekHistory(weekId: number, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return queryContract<WeekResponse>(RPC, {
    address: contractAddress,
    query: { get_week_history: { week_id: weekId } },
  });
}

export function getWeeklyConfig(contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return queryContract<WeeklyConfigResponse>(RPC, {
    address: contractAddress,
    query: { get_config: {} },
  });
}

export type TodayPriceResponse = {
  price: string;
  denom: string;
};

export function getTodayPrice(contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return queryContract<TodayPriceResponse>(RPC, {
    address: contractAddress,
    query: { get_today_price: {} },
  });
}

export type WeeklyEntrantsResponse = {
  // One entry per ticket, duplicates for wallets that bought more than one -
  // mirrors contracts/weekly-round/src/state.rs's Week.entrants exactly.
  entrants: string[];
};

export function getWeekEntrants(weekId: number, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return queryContract<WeeklyEntrantsResponse>(RPC, {
    address: contractAddress,
    query: { get_week_entrants: { week_id: weekId } },
  });
}

export type WeeklyWinningEntry = {
  week_id: number;
  prize_remaining: string;
};

export type WeeklyMyWinningsResponse = {
  winnings: WeeklyWinningEntry[];
};

// Surfaces every past week a wallet won and hasn't fully redeemed yet - same
// role as Wheel Manager's GetMyWinnings, see queryWheelManager.ts.
export function getMyWeeklyWinnings(wallet: string, contractAddress: string = WEEKLY_ROUND_ADDRESS) {
  return queryContract<WeeklyMyWinningsResponse>(RPC, {
    address: contractAddress,
    query: { get_my_winnings: { wallet } },
  });
}

// Prize split applied at DrawWeeklyWinner time (contracts/weekly-round/src/
// execute.rs, PRIZE_BPS = 8500) - while a week is still open, `pool` is the
// gross (ticket sales + wheel contributions) collected so far, not the prize
// itself. Mirrored here so the UI can show a live projected prize without a
// dedicated query. Deliberately higher than Wheel of Repeg's 0.6 - this pool
// already had its own "next round"/treasury/admin split happen upstream, at
// each Wheel Manager round, so Weekly Round doesn't carry a further slice
// forward the same way.
export const WEEKLY_PRIZE_SHARE = 0.85;
