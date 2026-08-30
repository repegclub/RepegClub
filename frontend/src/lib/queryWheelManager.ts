import { queryContract } from "@goblinhunt/cosmes/client";
import { RPC } from "./chainConfig";
import { WHEEL_MANAGER_ADDRESS } from "./deployment";

// Mirrors contracts/wheel-manager/src/msg.rs - keep in sync if that changes.
export type WheelRoundStatus = "open" | "closed" | "expiry_pending" | "drawn" | "expired";

export type WheelRoundResponse = {
  round_id: number;
  status: WheelRoundStatus;
  ticket_count: number;
  unique_player_count: number;
  pool: string;
  opened_at: number;
  // Rolling "soft close" deadline (unix seconds) - unset until min_players
  // is reached, then pushed forward on every ticket purchase from then on.
  // Not a fixed timer from opened_at.
  deadline: number | null;
  closed_at: number | null;
  closed_at_height: number | null;
  drawn_at: number | null;
  // The hash this round must be revealed against (hex) - lets anyone confirm
  // revealed_preimage (once set) actually satisfies it before trusting
  // winner.
  commit_used: string | null;
  // The secret that unlocked commit_used (hex), once revealed - lets anyone
  // independently recompute pick_winner_index and check it against winner.
  // See lib/verifyRound.ts.
  revealed_preimage: string | null;
  winner: string | null;
  prize_remaining: string;
  expired_at: number | null;
};

export type WheelConfigResponse = {
  admin: string;
  ticket_price: string;
  ticket_denom: string;
  redemption_denom: string;
  min_players: number;
  max_players: number;
  round_timeout_seconds: number;
  unclaimed_deadline_days: number;
  // Hard ceiling (seconds since opened_at) on how long a round stays Open -
  // caps the rolling deadline extension, and is also when ExpireRound
  // becomes callable if min_players was never reached.
  max_round_age_seconds: number;
  // How long a Closed round can go unrevealed before the 3-phase outage
  // expiration (RequestExpireClosedRound/etc, see lib/roundActions.ts)
  // becomes callable.
  max_reveal_age_seconds: number;
  treasury_address: string;
  admin_fee_address: string;
  weekly_round_address: string;
  commit_pusher: string;
};

export function getCurrentRound(contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return queryContract<WheelRoundResponse>(RPC, {
    address: contractAddress,
    query: { get_current_round: {} },
  });
}

export function getConfig(contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return queryContract<WheelConfigResponse>(RPC, {
    address: contractAddress,
    query: { get_config: {} },
  });
}

// Fetches a specific round by ID rather than whatever's currently open -
// needed because DrawWinner immediately advances the contract's "current
// round" to a fresh empty one in the same tx, so the round that was just
// decided has to be looked up by its own ID from then on.
export function getRoundHistory(roundId: number, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return queryContract<WheelRoundResponse>(RPC, {
    address: contractAddress,
    query: { get_round_history: { round_id: roundId } },
  });
}

export type EntrantsResponse = {
  // One entry per ticket, duplicates for wallets that bought more than one -
  // mirrors contracts/wheel-manager/src/state.rs's Round.entrants exactly.
  entrants: string[];
};

export function getRoundEntrants(roundId: number, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return queryContract<EntrantsResponse>(RPC, {
    address: contractAddress,
    query: { get_round_entrants: { round_id: roundId } },
  });
}

export type WinningEntry = {
  round_id: number;
  prize_remaining: string;
};

export type MyWinningsResponse = {
  winnings: WinningEntry[];
};

// Surfaces every past round a wallet won and hasn't fully redeemed yet,
// independent of whichever round the UI currently happens to be viewing -
// without this, redeeming an older win requires the UI to still have that
// specific round "pinned" (e.g. right after watching the reveal), which is
// lost on a page refresh or navigating away.
export function getMyWinnings(wallet: string, contractAddress: string = WHEEL_MANAGER_ADDRESS) {
  return queryContract<MyWinningsResponse>(RPC, {
    address: contractAddress,
    query: { get_my_winnings: { wallet } },
  });
}

// Prize split applied at DrawWinner time (contracts/wheel-manager/src/
// execute.rs, PRIZE_BPS) - while a round is still open, `pool` is the gross
// ticket revenue collected so far, not the prize itself. Mirrored here so
// the UI can show a live projected prize without a dedicated query.
export const PRIZE_SHARE = 0.6;

export type WalletStatsResponse = {
  total_invested: string;
  total_redeemed: string;
};

// Takes an explicit contract address (rather than defaulting to
// WHEEL_MANAGER_ADDRESS like the rest of this file) since lifetime stats are
// meant to be summed across every deployed tier, not just this frontend's
// single wired-up one - see hooks/useLifetimeStats.ts.
export function getWalletStats(wallet: string, contractAddress: string) {
  return queryContract<WalletStatsResponse>(RPC, {
    address: contractAddress,
    query: { get_wallet_stats: { wallet } },
  });
}
