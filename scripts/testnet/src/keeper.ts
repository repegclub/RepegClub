// Keeper bot: fires CloseRound/RevealDraw (Wheel Manager, Weekly Round) and
// CloseRound/RevealDraw (every Create Your Own Luck raffle deployed through
// a discovered factory) as soon as each becomes legally possible, plus the
// 3-phase expiration cascade (Request/Finalize/Claim) as an outage safety
// net for a round/week/raffle that closed and never got revealed in time.
//
// Under v9 (commit-reveal), revealing needs the preimage that satisfies
// whatever commit got assigned - this process only ever holds preimages
// generated and pushed on-chain separately by generateAndPushCommits.ts
// (via keeperSecrets.ts's local store). This process's own wallet
// (KEEPER_MNEMONIC) is deliberately NOT the `commit_pusher` role and never
// needs to be - see the project's Obsidian notes ("Grinding vía
// SubMsg+reply") for why that separation matters.
//
// CloseRound/RevealDraw/expiration steps are all permissionless by design -
// anyone can call them - so this bot holds no special privilege for any of
// them. Its only job is to act the instant each becomes possible.

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";
import { discoverTargets, Target } from "./keeperTargets";
import { findPreimage, consumeSecret } from "./keeperSecrets";
import { getCursor, setCursor, isRaffleTerminal, markRaffleTerminal } from "./keeperState";

const POLL_INTERVAL_MS = 15_000;
// Round-history walk: bounds how many already-resolved rounds/weeks a single
// tick will skip past when catching up a long-idle cursor.
const MAX_CURSOR_ADVANCE_PER_TICK = 30;
// Mirrors create-your-own-luck's own `MAX_RAFFLE_AGE_SECONDS` (contract.rs) -
// fixed platform-wide there, not queryable via any QueryMsg, so it has to be
// mirrored here to avoid spamming ExpireRaffle attempts on every open raffle
// that simply hasn't reached min_players yet (the common, long-lived case -
// unlike the Closed/ExpiryPending branches below, which are rare enough that
// optimistic per-tick attempts are cheap even without precise gating). Keep
// in sync with contracts/create-your-own-luck/src/contract.rs.
const CYOL_MAX_RAFFLE_AGE_SECONDS_MIRROR = 5_184_000; // 60 days
const CYOL_RAFFLES_PAGE_LIMIT = 100;

// Block time, not Date.now() - the contracts' deadline/duration checks
// compare against block.time, and this machine's clock can drift from it -
// CodeRabbit review (2026-07-15) flagged that a drifted local clock could
// make the keeper submit close_round/close_week slightly early and burn gas
// on an avoidable rejection.
async function currentBlockTimeSeconds(): Promise<number> {
  const res = await fetch(`${RPC}/status`);
  const body = await res.json();
  return Math.floor(new Date(body.result.sync_info.latest_block_time).getTime() / 1000);
}

type CloseOrRevealAction = "reveal" | "request_expire" | "finalize_expire" | "claim_expire";

/**
 * What to do with a round/week/raffle that's already Closed or ExpiryPending.
 * Shared across wheel-manager/weekly-round/CYOL since `RevealDraw`'s own
 * status guard (Closed or ExpiryPending) and the 3-phase expiration cascade
 * are identical in all 3 contracts (see wheel-manager's `execute_reveal_draw`/
 * `execute_request_expire_closed_round`/etc. and their CYOL/weekly-round
 * doc-comment cross-references).
 *
 * Deliberately does NOT try to replicate the contracts' own block-height
 * gating for the expiration cascade (`EXPIRE_FINALIZE_DELAY_BLOCKS`/
 * `EXPIRE_CHALLENGE_BLOCKS`/etc.) - none of those intermediate timestamps
 * (`expire_requested_at_height`/`expiry_pending_since_height`) are exposed
 * by any query, and this whole cascade only activates during an outage (a
 * reveal that didn't happen in time), which is rare enough that an
 * optimistic per-tick attempt - quietly ignored if the contract says it's
 * too early - is cheap and simpler than trying to reconstruct the timing.
 */
function pickActions(status: string, commitUsed: string | null): CloseOrRevealAction[] {
  if (commitUsed) {
    const preimage = findPreimage(commitUsed);
    if (preimage) return ["reveal"];
  }
  if (status === "closed") return ["request_expire", "finalize_expire"];
  if (status === "expiry_pending") return ["claim_expire"];
  return [];
}

async function sendExecute(
  keeper: ReturnType<typeof loadWallet>,
  contract: string,
  msg: object,
  { quiet = false }: { quiet?: boolean } = {}
) {
  try {
    const res = await keeper.broadcastTxSync({
      msgs: [new MsgExecuteContract({ sender: keeper.address, contract, msg, funds: [] })],
      memo: "REPEG CLUB",
    });
    if (res.txResponse.code !== 0) {
      if (!quiet) console.error(`  tx failed: ${res.txResponse.rawLog}`);
      return undefined;
    }
    console.log(`  ok | gasUsed: ${res.txResponse.gasUsed} | tx: ${res.txResponse.txhash}`);
    return res;
  } catch (err) {
    if (!quiet) console.error(`  broadcast error: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Executes whichever action(s) `pickActions` returned for a Closed/
 * ExpiryPending round/week/raffle. `idField` is `{round_id}`/`{week_id}`/`{}`
 * (CYOL has no id - one raffle per instance). `label` is for logging only.
 */
async function executeCloseOrRevealActions(
  keeper: ReturnType<typeof loadWallet>,
  contract: string,
  label: string,
  actions: CloseOrRevealAction[],
  idField: Record<string, unknown>,
  commitUsed: string | null
) {
  for (const action of actions) {
    if (action === "reveal") {
      const preimage = findPreimage(commitUsed!)!;
      console.log(`[${label}] revealing with the matching preimage`);
      const res = await sendExecute(keeper, contract, { reveal_draw: { ...idField, preimage } });
      if (res && res.txResponse.code === 0) consumeSecret(commitUsed!);
      return; // reveal supersedes any expiration step - nothing else to try this tick
    }
    if (action === "request_expire") {
      console.warn(`[${label}] closed with no local preimage for its commit - trying the expiration safety net`);
      await sendExecute(keeper, contract, { [`request_expire_closed_${idKind(idField)}`]: { ...idField } }, { quiet: true });
    }
    if (action === "finalize_expire") {
      await sendExecute(keeper, contract, { [`finalize_expire_closed_${idKind(idField)}`]: { ...idField } }, { quiet: true });
    }
    if (action === "claim_expire") {
      await sendExecute(keeper, contract, { [`claim_expired_${idKind(idField)}`]: { ...idField } }, { quiet: true });
    }
  }
}

// The 3-phase expiration messages are named *_round/*_week/*_raffle - this
// picks the right suffix from which id field (if any) a target uses, so
// `executeCloseOrRevealActions` above can stay shared instead of duplicated
// 3 times with only the message names different.
function idKind(idField: Record<string, unknown>): "round" | "week" | "raffle" {
  if ("round_id" in idField) return "round";
  if ("week_id" in idField) return "week";
  return "raffle";
}

async function tickWheelManager(keeper: ReturnType<typeof loadWallet>, target: Target, nowSeconds: number) {
  const cursorKey = `wheel-manager:${target.label}`;
  let roundId = getCursor(cursorKey);
  const config = await queryContract<any>(RPC, { address: target.address, query: { get_config: {} } });

  for (let steps = 0; steps < MAX_CURSOR_ADVANCE_PER_TICK; steps++) {
    let round: any;
    try {
      round = await queryContract<any>(RPC, { address: target.address, query: { get_round_history: { round_id: roundId } } });
    } catch (err) {
      console.error(`[${target.label}] round ${roundId} lookup failed: ${(err as Error).message}`);
      break;
    }

    if (round.status === "drawn" || round.status === "expired") {
      roundId += 1;
      continue;
    }

    if (round.status === "open") {
      // Matches wheel-manager's real execute_close_round condition (rolling
      // `deadline`, reset on every ticket). `reached_max` isn't checked here -
      // BuyTicket already auto-closes the round the instant max_players is
      // hit, so status never sits "open" with reached_max true waiting on
      // this poll.
      const hasMin = round.unique_player_count >= config.min_players;
      const deadlinePassed = round.deadline !== null && nowSeconds >= round.deadline;
      const hardCapPassed = nowSeconds >= round.opened_at + config.max_round_age_seconds;
      if (deadlinePassed || (hasMin && hardCapPassed)) {
        const reason = deadlinePassed ? "rolling deadline passed" : "hard cap reached with min players";
        console.log(`[${target.label}] round ${roundId} eligible to close (${reason}) - closing`);
        await sendExecute(keeper, target.address, { close_round: {} });
      }
      break;
    }

    // closed or expiry_pending - front of REVEAL_QUEUE, needs action.
    const actions = pickActions(round.status, round.commit_used);
    await executeCloseOrRevealActions(keeper, target.address, target.label, actions, { round_id: roundId }, round.commit_used);
    break;
  }

  setCursor(cursorKey, roundId);
}

async function tickWeeklyRound(keeper: ReturnType<typeof loadWallet>, target: Target, nowSeconds: number) {
  const cursorKey = `weekly-round:${target.label}`;
  let weekId = getCursor(cursorKey);
  const config = await queryContract<any>(RPC, { address: target.address, query: { get_config: {} } });

  for (let steps = 0; steps < MAX_CURSOR_ADVANCE_PER_TICK; steps++) {
    let week: any;
    try {
      week = await queryContract<any>(RPC, { address: target.address, query: { get_week_history: { week_id: weekId } } });
    } catch (err) {
      console.error(`[${target.label}] week ${weekId} lookup failed: ${(err as Error).message}`);
      break;
    }

    if (week.status === "drawn" || week.status === "expired") {
      weekId += 1;
      continue;
    }

    if (week.status === "open") {
      const durationElapsed = nowSeconds >= week.opened_at + config.round_duration_days * 86400;
      const hasMin = week.unique_player_count >= config.min_players;
      if (durationElapsed && hasMin) {
        console.log(`[${target.label}] week ${weekId} reached its full duration with enough players - closing`);
        await sendExecute(keeper, target.address, { close_week: {} });
      }
      break;
    }

    const actions = pickActions(week.status, week.commit_used);
    await executeCloseOrRevealActions(keeper, target.address, target.label, actions, { week_id: weekId }, week.commit_used);
    break;
  }

  setCursor(cursorKey, weekId);
}

async function discoverCyolRaffles(factoryAddress: string): Promise<string[]> {
  const addresses: string[] = [];
  let startAfter: number | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page: any = await queryContract<any>(RPC, {
      address: factoryAddress,
      query: { get_raffles: { start_after: startAfter, limit: CYOL_RAFFLES_PAGE_LIMIT } },
    });
    for (const record of page.raffles) {
      if (!isRaffleTerminal(record.address)) addresses.push(record.address);
    }
    if (page.raffles.length < CYOL_RAFFLES_PAGE_LIMIT) break;
    startAfter = page.raffles[page.raffles.length - 1].index;
  }
  return addresses;
}

async function tickCyolRaffle(keeper: ReturnType<typeof loadWallet>, raffleAddress: string, nowSeconds: number) {
  let status: any;
  try {
    status = await queryContract<any>(RPC, { address: raffleAddress, query: { get_raffle_status: {} } });
  } catch (err) {
    console.error(`[cyol:${raffleAddress}] status lookup failed: ${(err as Error).message}`);
    return;
  }

  if (status.status === "drawn" || status.status === "cancelled") {
    markRaffleTerminal(raffleAddress);
    return;
  }

  if (status.status === "open") {
    if (status.seconds_remaining !== null && status.seconds_remaining <= 0) {
      console.log(`[cyol:${raffleAddress}] deadline passed - closing`);
      await sendExecute(keeper, raffleAddress, { close_round: {} });
      return;
    }
    // Safety net for a raffle that never reached min_players - see
    // CYOL_MAX_RAFFLE_AGE_SECONDS_MIRROR's own doc comment for why this is
    // hardcoded and gated (unlike the Closed/ExpiryPending branch below).
    if (status.opened_at !== null && nowSeconds >= status.opened_at + CYOL_MAX_RAFFLE_AGE_SECONDS_MIRROR) {
      await sendExecute(keeper, raffleAddress, { expire_raffle: {} }, { quiet: true });
    }
    return;
  }

  // Funding/AwaitingCommit: nothing for the keeper to do - waiting on the
  // creator (funding) or a same-transaction SubMsg reply (AwaitingCommit,
  // never actually observable at rest - see RaffleStatus's own doc comment).
  if (status.status === "funding" || status.status === "awaiting_commit") return;

  // closed or expiry_pending.
  const actions = pickActions(status.status, status.commit_used);
  await executeCloseOrRevealActions(keeper, raffleAddress, `cyol:${raffleAddress}`, actions, {}, status.commit_used);
}

async function tick(keeper: ReturnType<typeof loadWallet>, targets: Target[]) {
  const nowSeconds = await currentBlockTimeSeconds();
  for (const target of targets) {
    try {
      if (target.type === "wheel-manager") {
        await tickWheelManager(keeper, target, nowSeconds);
      } else if (target.type === "weekly-round") {
        await tickWeeklyRound(keeper, target, nowSeconds);
      } else {
        const raffles = await discoverCyolRaffles(target.address);
        for (const raffleAddress of raffles) {
          await tickCyolRaffle(keeper, raffleAddress, nowSeconds);
        }
      }
    } catch (err) {
      console.error(`[${target.label}] tick error: ${(err as Error).message}`);
    }
  }
}

// Round-review fix (Fable, commit_pusher audit round, 2026-08-30): the
// KEEPER_MNEMONIC->ADMIN_MNEMONIC fallback above (kept for local-testing
// convenience) used to be silent - a production deploy that forgot to set
// KEEPER_MNEMONIC would start this always-on, internet-exposed process with
// the real admin key with no error and no warning, defeating the exact
// keeper/admin separation this project's commit_pusher role split exists to
// model. Confirm the loaded wallet isn't actually admin (or commit_pusher)
// on any watched contract before starting the poll loop - covers all 3
// target types (the CYOL factory's GetConfig didn't expose admin/
// commit_pusher until this same round, see its query.rs).
async function assertKeeperIsNotAPrivilegedWallet(keeperAddress: string, targets: Target[]) {
  for (const target of targets) {
    const config = await queryContract<{ admin: string; commit_pusher: string }>(RPC, {
      address: target.address,
      query: { get_config: {} },
    });
    if (keeperAddress === config.admin || keeperAddress === config.commit_pusher) {
      console.error(
        `FATAL: the keeper's own wallet (${keeperAddress}) is also ${
          keeperAddress === config.admin ? "admin" : "commit_pusher"
        } on ${target.type}:${target.label} (${target.address}). Refusing to start - an always-on, ` +
          `internet-exposed process must never hold either of those roles. Set KEEPER_MNEMONIC to a ` +
          `dedicated wallet distinct from both admin and commit_pusher.`
      );
      process.exit(1);
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

  await assertKeeperIsNotAPrivilegedWallet(keeper.address, targets);

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
