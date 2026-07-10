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

async function currentBlockHeight(): Promise<number> {
  const res = await fetch(`${RPC}/status`);
  const body = await res.json();
  return Number(body.result.sync_info.latest_block_height);
}

async function tickWheelManager(keeper: ReturnType<typeof loadWallet>, target: Target, height: number) {
  const [round, config] = await Promise.all([
    queryContract<any>(RPC, { address: target.address, query: { get_current_round: {} } }),
    queryContract<any>(RPC, { address: target.address, query: { get_config: {} } }),
  ]);

  if (round.status === "open") {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timeoutElapsed = nowSeconds >= round.opened_at + config.round_timeout_seconds;
    const hasMin = round.unique_player_count >= config.min_players;
    if (timeoutElapsed && hasMin) {
      console.log(`[${target.label}] round ${round.round_id} timed out with enough players - closing`);
      await sendExecute(keeper, target.address, { close_round: {} });
    }
    return;
  }

  if (round.status === "closed") {
    if (round.draw_after_height !== null && height >= round.draw_after_height) {
      console.log(`[${target.label}] round ${round.round_id} eligible for draw at height ${height} - drawing now`);
      await sendExecute(keeper, target.address, { draw_winner: {} });
    }
  }
}

async function tickWeeklyRound(keeper: ReturnType<typeof loadWallet>, target: Target, height: number) {
  const [week, config] = await Promise.all([
    queryContract<any>(RPC, { address: target.address, query: { get_current_week: {} } }),
    queryContract<any>(RPC, { address: target.address, query: { get_config: {} } }),
  ]);

  if (week.status === "open") {
    const nowSeconds = Math.floor(Date.now() / 1000);
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
      await sendExecute(keeper, target.address, { draw_weekly_winner: {} });
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
    });
    if (res.txResponse.code !== 0) {
      console.error(`  tx failed: ${res.txResponse.rawLog}`);
    } else {
      console.log(`  ok | gasUsed: ${res.txResponse.gasUsed} | tx: ${res.txResponse.txhash}`);
    }
  } catch (err) {
    console.error(`  broadcast error: ${(err as Error).message}`);
  }
}

async function tick(keeper: ReturnType<typeof loadWallet>, targets: Target[]) {
  const height = await currentBlockHeight();
  for (const target of targets) {
    try {
      if (target.type === "wheel-manager") {
        await tickWheelManager(keeper, target, height);
      } else {
        await tickWeeklyRound(keeper, target, height);
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
