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

import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../keeper-state.json");

interface KeeperState {
  cursors: Record<string, number>;
  terminalRaffles: string[];
}

function load(): KeeperState {
  if (!existsSync(STATE_FILE)) return { cursors: {}, terminalRaffles: [] };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
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
