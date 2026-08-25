// Keeper bot: fires CloseRound/DrawWinner (Wheel Manager) and CloseWeek/
// DrawWeeklyWinner (Weekly Round) as soon as each becomes legally possible.
// These actions are permissionless by design - anyone can call them - so this
// bot holds no special privilege. Its only job is to remove the "wait and see
// which block favors me" window by always acting the instant it's allowed,
// closing the timing-grinding gap described in the 2026-07-08 security review.

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "..");
const POLL_INTERVAL_MS = 15_000;

type Target =
  | { type: "wheel-manager"; label: string; address: string }
  | { type: "weekly-round"; label: string; address: string };

function discoverTargets(): Target[] {
  const targets: Target[] = [];
  for (const file of readdirSync(SCRIPTS_DIR)) {
    const wheelMatch = file.match(/^deployment-wheelmanager-(.+)\.json$/);
    if (wheelMatch) {
      const { contractAddress } = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, file), "utf8"));
      targets.push({ type: "wheel-manager", label: wheelMatch[1], address: contractAddress });
    }
    if (file === "deployment-weekly-round.json") {
      const { contractAddress } = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, file), "utf8"));
      targets.push({ type: "weekly-round", label: "weekly-round", address: contractAddress });
    }
  }
  return targets;
}

// Chain height + time in one call. Using the block time here (not
// Date.now()) matters: the contract's deadline/duration checks compare
// against block.time, and this machine's clock can drift from it - CodeRabbit
// review (2026-07-15) flagged that a drifted local clock could make the
// keeper submit close_round/close_week slightly early and burn gas on an
// avoidable rejection.
async function currentChainState(): Promise<{ height: number; nowSeconds: number }> {
  const res = await fetch(`${RPC}/status`);
  const body = await res.json();
  return {
    height: Number(body.result.sync_info.latest_block_height),
    nowSeconds: Math.floor(new Date(body.result.sync_info.latest_block_time).getTime() / 1000),
  };
}

async function tickWheelManager(
  keeper: ReturnType<typeof loadWallet>,
  target: Target,
  height: number,
  nowSeconds: number
) {
  const [round, config] = await Promise.all([
    queryContract<any>(RPC, { address: target.address, query: { get_current_round: {} } }),
    queryContract<any>(RPC, { address: target.address, query: { get_config: {} } }),
  ]);

  if (round.status === "open") {
    // Matches wheel-manager's real execute_close_round condition (rolling
    // `deadline`, reset on every ticket since 2026-07-10 - NOT a fixed
    // opened_at + round_timeout_seconds window, that formula was replaced by
    // the rolling redesign and left this keeper checking the wrong signal,
    // found live 2026-07-15 spamming rejected CloseRound calls every tick).
    // `reached_max` isn't checked here - BuyTicket already auto-closes AND
    // draws the round in the same tx the instant max_players is hit
    // (2026-08-24 audit fix), so status never sits "open" (or even "closed")
    // with reached_max true waiting on this poll - it jumps straight to
    // "drawn".
    const hasMin = round.unique_player_count >= config.min_players;
    const deadlinePassed = round.deadline !== null && nowSeconds >= round.deadline;
    const hardCapPassed = nowSeconds >= round.opened_at + config.max_round_age_seconds;
    if (deadlinePassed || (hasMin && hardCapPassed)) {
      const reason = deadlinePassed ? "rolling deadline passed" : "hard cap reached with min players";
      console.log(`[${target.label}] round ${round.round_id} eligible to close (${reason}) - closing`);
      await sendExecute(keeper, target.address, { close_round: {} });
    }
    return;
  }

  if (round.status === "closed") {
    if (round.draw_after_height !== null && height >= round.draw_after_height) {
      console.log(`[${target.label}] round ${round.round_id} eligible for draw at height ${height} - drawing now`);
      await sendExecuteAndWarnIfRearmed(keeper, target.address, { draw_winner: {} }, target.label);
    }
  }
}

async function tickWeeklyRound(
  keeper: ReturnType<typeof loadWallet>,
  target: Target,
  height: number,
  nowSeconds: number
) {
  const [week, config] = await Promise.all([
    queryContract<any>(RPC, { address: target.address, query: { get_current_week: {} } }),
    queryContract<any>(RPC, { address: target.address, query: { get_config: {} } }),
  ]);

  if (week.status === "open") {
    const durationElapsed = nowSeconds >= week.opened_at + config.round_duration_days * 86400;
    const hasMin = week.unique_player_count >= config.min_players;
    if (durationElapsed && hasMin) {
      console.log(`[${target.label}] week ${week.week_id} reached its full duration with enough players - closing`);
      await sendExecute(keeper, target.address, { close_week: {} });
    }
    return;
  }

  if (week.status === "closed") {
    if (week.draw_after_height !== null && height >= week.draw_after_height) {
      console.log(`[${target.label}] week ${week.week_id} eligible for draw at height ${height} - drawing now`);
      await sendExecuteAndWarnIfRearmed(keeper, target.address, { draw_weekly_winner: {} }, target.label);
    }
  }
}

async function sendExecute(keeper: ReturnType<typeof loadWallet>, contract: string, msg: object) {
  try {
    const res = await keeper.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: keeper.address,
          contract,
          msg,
          funds: [],
        }),
      ],
      memo: "REPEG CLUB",
    });
    if (res.txResponse.code !== 0) {
      console.error(`  tx failed: ${res.txResponse.rawLog}`);
    } else {
      console.log(`  ok | gasUsed: ${res.txResponse.gasUsed} | tx: ${res.txResponse.txhash}`);
    }
    return res;
  } catch (err) {
    console.error(`  broadcast error: ${(err as Error).message}`);
    return undefined;
  }
}

// DrawWinner/DrawWeeklyWinner rearm instead of drawing if called past the
// draw window ceiling (see draw_window_blocks) - this keeper polls every
// POLL_INTERVAL_MS and always draws the instant it's eligible, so a rearm
// happening here means this keeper itself was delayed by an entire window's
// worth of blocks (RPC lag, downtime, etc.) - worth a loud warning, since
// that's exactly the operational signal a silently-unbounded window would
// otherwise hide.
async function sendExecuteAndWarnIfRearmed(
  keeper: ReturnType<typeof loadWallet>,
  contract: string,
  msg: object,
  label: string
) {
  const res = await sendExecute(keeper, contract, msg);
  const action = res?.txResponse.events
    .find((e) => e.type === "wasm")
    ?.attributes.find((a) => a.key === "action")?.value;
  if (action === "rearm_draw_window") {
    console.warn(`[${label}] draw window was missed - rearmed instead of drawing. Check keeper uptime/latency.`);
  }
}

async function tick(keeper: ReturnType<typeof loadWallet>, targets: Target[]) {
  const { height, nowSeconds } = await currentChainState();
  for (const target of targets) {
    try {
      if (target.type === "wheel-manager") {
        await tickWheelManager(keeper, target, height, nowSeconds);
      } else {
        await tickWeeklyRound(keeper, target, height, nowSeconds);
      }
    } catch (err) {
      console.error(`[${target.label}] tick error: ${(err as Error).message}`);
    }
  }
}

async function main() {
  const keeper = loadWallet(process.env.KEEPER_MNEMONIC ? "KEEPER_MNEMONIC" : "ADMIN_MNEMONIC");
  console.log("Keeper address:", keeper.address);

  const targets = discoverTargets();
  console.log(
    `Watching ${targets.length} contract(s):`,
    targets.map((t) => `${t.type}:${t.label}`).join(", ")
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick(keeper, targets);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
