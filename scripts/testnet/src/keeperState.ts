// Small persisted operational state for keeper.ts - no secrets here, just
// bookkeeping - but kept out of git anyway since it's mutable runtime state,
// not a deployment descriptor (see scripts/testnet/.gitignore).
//
// `cursors`: for wheel-manager/weekly-round, the oldest round/week id that
// might still be sitting unrevealed at the front of REVEAL_QUEUE. Needed
// because `GetCurrentRound`/`GetCurrentWeek` only ever shows the newest
// round/week (a new one opens the instant the previous one closes - see
// `close_round_and_advance`), so an older Closed round awaiting reveal can
// become invisible to a keeper that only checks "current" once a newer one
// has opened. Walking forward from this cursor via `GetRoundHistory`/
// `GetWeekHistory` finds it regardless of how long a backlog it's chasing.
//
// `terminalRaffles`: CYOL raffle addresses already confirmed Drawn/Cancelled
// - skipped in future ticks so the keeper's RPC load doesn't grow forever as
// the platform accumulates finished raffles.
//
// `expirePhases`: the height the keeper last attempted each step of the
// 3-phase expiration cascade (request/finalize/claim) for a given closed/
// expiry_pending round/week/raffle - added 2026-09-20 (CodeRabbit finding,
// PR #54, fifth review round) because none of the contracts expose
// `expire_requested_at_height`/`expiry_pending_since_height` via any query,
// so the keeper has nowhere else to learn "did my own request/finalize
// attempt actually land, and how long ago" - see keeperExpireLogic.ts's
// `nextExpireAction` for how this is used to gate retries against the real
// on-chain block-height windows instead of hammering every ~15s tick.

import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import type { ExpireAction, ExpirePhaseState } from "./keeperExpireLogic";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../keeper-state.json");

export type { ExpirePhaseState };

interface KeeperState {
  cursors: Record<string, number>;
  terminalRaffles: string[];
  expirePhases: Record<string, ExpirePhaseState>;
}

function load(): KeeperState {
  if (!existsSync(STATE_FILE)) return { cursors: {}, terminalRaffles: [], expirePhases: {} };
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  // Files written before this field existed won't have it.
  state.expirePhases ??= {};
  return state;
}

function save(state: KeeperState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getCursor(key: string): number {
  return load().cursors[key] ?? 1;
}

export function setCursor(key: string, value: number) {
  const state = load();
  state.cursors[key] = value;
  save(state);
}

export function isRaffleTerminal(address: string): boolean {
  return load().terminalRaffles.includes(address);
}

export function markRaffleTerminal(address: string) {
  const state = load();
  if (!state.terminalRaffles.includes(address)) {
    state.terminalRaffles.push(address);
    save(state);
  }
}

export function getExpirePhase(key: string): ExpirePhaseState {
  return load().expirePhases[key] ?? {};
}

// `succeeded` must reflect the real on-chain tx result, not just that a
// broadcast was attempted - see ExpirePhaseState's own comment on
// requestSucceededHeight for why this distinction matters for request_expire
// specifically (CodeRabbit finding, 2026-09-20 review, sixth round).
export function recordExpireAttempt(key: string, action: ExpireAction, height: number, succeeded: boolean) {
  const state = load();
  const phase = state.expirePhases[key] ?? {};
  if (action === "request_expire") {
    phase.lastRequestAttemptHeight = height;
    if (succeeded) phase.requestSucceededHeight = height;
  }
  if (action === "finalize_expire") phase.finalizeAttemptHeight = height;
  if (action === "claim_expire") phase.claimAttemptHeight = height;
  state.expirePhases[key] = phase;
  save(state);
}
