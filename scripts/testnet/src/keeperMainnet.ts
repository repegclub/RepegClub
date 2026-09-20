// Keeper bot: fires CloseRound/RevealDraw (Wheel Manager, Weekly Round) and
// CloseRound/RevealDraw (every Create Your Own Luck raffle deployed through
// a discovered factory) as soon as each becomes legally possible, plus the
// 3-phase expiration cascade (Request/Finalize/Claim) as an outage safety
// net for a round/week/raffle that closed and never got revealed in time.
//
// Real mainnet variant of keeper.ts - only real difference is the ./config
// import below (testnet -> ./configMainnet), same reasoning as every other
// Mainnet-suffixed script in this project: kept as a full separate file
// rather than a parameterized shared one, so a testnet/mainnet config can
// never get mixed up by accident. Meant to run from its own separate
// directory on the VM (not the same one as the testnet keeper), so
// discoverTargets() (keeperTargets.ts, scoped to its own directory) only
// ever sees mainnet deployment-*.json files - see the Obsidian mainnet
// deploy plan for the VM layout.
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

import { RPC, loadWallet } from "./configMainnet";
import { discoverTargets, SCRIPTS_DIR, Target } from "./keeperTargets";
import { findPreimage, consumeSecret } from "./keeperSecrets";
import { getCursor, setCursor, isRaffleTerminal, markRaffleTerminal, getExpirePhase, recordExpireAttempt } from "./keeperState";
import { nextExpireAction, type ExpireAction } from "./keeperExpireLogic";

const POLL_INTERVAL_MS = 15_000;
// Round-history walk: bounds how many already-resolved rounds/weeks a single
// tick will skip past when catching up a long-idle cursor.
const MAX_CURSOR_ADVANCE_PER_TICK = 30;
// Mirrors create-your-own-luck's own `MAX_RAFFLE_AGE_SECONDS` (contract.rs) -
// fixed platform-wide there, not queryable via any QueryMsg, so it has to be
// mirrored here to avoid spamming ExpireRaffle attempts on every open raffle
// that simply hasn't reached min_players yet. Keep in sync with
// contracts/create-your-own-luck/src/contract.rs.
const CYOL_MAX_RAFFLE_AGE_SECONDS_MIRROR = 5_184_000; // 60 days
// Same reasoning, mirrors contract.rs's MAX_REVEAL_AGE_SECONDS (fixed for
// CYOL, unlike wheel-manager/weekly-round where it's per-contract config) -
// used by nextExpireAction's request_expire gate for CYOL raffles below.
const CYOL_MAX_REVEAL_AGE_SECONDS_MIRROR = 3_600; // 1 hour
const CYOL_RAFFLES_PAGE_LIMIT = 100;

// Block time, not Date.now() - the contracts' deadline/duration checks
// compare against block.time, and this machine's clock can drift from it -
// CodeRabbit review (2026-07-15) flagged that a drifted local clock could
// make the keeper submit close_round/close_week slightly early and burn gas
// on an avoidable rejection. Also returns block height, needed by the
// expiration-phase height gates below (nextExpireAction) - one /status call
// covers both instead of two.
async function currentBlockStatus(): Promise<{ seconds: number; height: number }> {
  // Without a bounded deadline, a stalled RPC could leave this promise
  // pending indefinitely - tick() awaits it before processing any target,
  // so a stall silently blocks every future poll (CodeRabbit finding,
  // 2026-09-19 review, fourth round). The timeout rejection is caught by
  // tick()'s existing try/catch same as any other fetch failure.
  const res = await fetch(`${RPC}/status`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`/status returned HTTP ${res.status}`);
  const body = await res.json();
  const rawTime = body.result?.sync_info?.latest_block_time;
  const seconds = Math.floor(new Date(rawTime).getTime() / 1000);
  // A missing/malformed latest_block_time used to silently become NaN here
  // instead of throwing (CodeRabbit finding, 2026-09-19 review) - every
  // deadline comparison downstream in tick() evaluates false against NaN,
  // so the keeper would just skip every target that tick instead of
  // retrying next tick via the try/catch tick() already has for this.
  if (!Number.isFinite(seconds)) throw new Error(`/status returned an unusable latest_block_time: ${JSON.stringify(rawTime)}`);
  const rawHeight = body.result?.sync_info?.latest_block_height;
  const height = Number(rawHeight);
  if (!Number.isFinite(height)) throw new Error(`/status returned an unusable latest_block_height: ${JSON.stringify(rawHeight)}`);
  return { seconds, height };
}

// nextExpireAction and its ExpireAction type live in keeperExpireLogic.ts
// (imported below) - not here, since this file's unconditional main() call
// at the bottom means it can never be imported by a test.

// Known, accepted limitation (CodeRabbit finding, 2026-09-20 review, eighth
// round, "heavy lift" - documented rather than implemented, same as the 2
// other heavy-lift findings from earlier rounds): a confirmed rejection
// (code !== 0) and a transport-level failure (network error/timeout -
// outcome unknown, the tx may have actually landed) both return `undefined`
// here, so recordExpireAttempt's `succeeded` flag treats them the same. If a
// request_expire attempt's true outcome was success but the response never
// reached this process, requestSucceededHeight never gets set, so the
// keeper retries request_expire against an already-live request - always
// rejected (ExpireAlreadyRequested), never learning the truth from that
// either. This self-heals once the real request's own REQUEST_EXPIRE_TTL_BLOCKS
// (200 blocks, ~20 min at LUNC's block time) elapses on-chain, at which
// point a fresh request_expire genuinely succeeds - bounded extra delay on
// an already-rare outage-recovery path, not a fund-safety issue or a
// permanently stuck state. A full fix would reconcile an ambiguous outcome
// by polling the chain for the tx's real result (same pattern as
// treasuryMultisigUiApp.ts's pollTxResult) - not done here to avoid scope
// creep into the broadcast layer this late in the review cycle.
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

// The 3-phase expiration messages are named *_round/*_week/*_raffle (except
// claim, named *_expired_* not *_expire_closed_*) - this picks the right
// suffix from which id field (if any) a target uses, so the function below
// can stay shared instead of duplicated 3 times with only the message names
// different.
function idKind(idField: Record<string, unknown>): "round" | "week" | "raffle" {
  if ("round_id" in idField) return "round";
  if ("week_id" in idField) return "week";
  return "raffle";
}

const EXPIRE_MSG_PREFIX: Record<ExpireAction, string> = {
  request_expire: "request_expire_closed",
  finalize_expire: "finalize_expire_closed",
  claim_expire: "claim_expired",
};

/**
 * Handles a Closed/ExpiryPending round/week/raffle: reveals immediately if
 * the keeper holds the matching preimage (unrelated to the expiration
 * cascade - always tried first, every tick, no gating needed), otherwise
 * consults `nextExpireAction` and attempts at most one expiration step this
 * tick, recording the attempt height so future ticks gate correctly.
 * `idField` is `{round_id}`/`{week_id}`/`{}` (CYOL has no id - one raffle
 * per instance). `phaseKey` must be unique per round/week/raffle (not just
 * per target) - see the call sites.
 */
async function handleClosedOrExpiryPending(
  keeper: ReturnType<typeof loadWallet>,
  contract: string,
  label: string,
  phaseKey: string,
  idField: Record<string, unknown>,
  item: { status: "closed" | "expiry_pending"; commit_used: string | null; closed_at: number | null },
  maxRevealAgeSeconds: number,
  chainTime: { seconds: number; height: number }
) {
  if (item.commit_used) {
    const preimage = findPreimage(item.commit_used);
    if (preimage) {
      console.log(`[${label}] revealing with the matching preimage`);
      const res = await sendExecute(keeper, contract, { reveal_draw: { ...idField, preimage } });
      if (res && res.txResponse.code === 0) consumeSecret(item.commit_used);
      return;
    }
  }

  const phase = getExpirePhase(phaseKey);
  const action = nextExpireAction({
    status: item.status,
    closedAtSeconds: item.closed_at,
    nowSeconds: chainTime.seconds,
    maxRevealAgeSeconds,
    currentHeight: chainTime.height,
    phase,
  });
  if (!action) return;

  if (action === "request_expire") {
    console.warn(`[${label}] closed with no local preimage for its commit - trying the expiration safety net`);
  }
  const res = await sendExecute(
    keeper,
    contract,
    { [`${EXPIRE_MSG_PREFIX[action]}_${idKind(idField)}`]: { ...idField } },
    { quiet: true }
  );
  // sendExecute returns undefined for both a rejected tx (code !== 0) and a
  // broadcast error - either way, this attempt did not land on-chain.
  recordExpireAttempt(phaseKey, action, chainTime.height, res !== undefined);
}

async function tickWheelManager(
  keeper: ReturnType<typeof loadWallet>,
  target: Target,
  chainTime: { seconds: number; height: number }
) {
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
      //
      // deadlinePassed alone (no explicit hasMin check) is deliberate, not a
      // gap - CodeRabbit flagged this (2026-09-20 review, tenth round), but
      // the contract's own execute_close_round has: "deadline is only ever
      // set once min_players is reached... so checking it alone already
      // implies has_min" (execute.rs). Verified against that comment before
      // skipping this one - adding a redundant `hasMin &&` here would change
      // nothing, since deadlinePassed can't be true without it.
      const hasMin = round.unique_player_count >= config.min_players;
      const deadlinePassed = round.deadline !== null && chainTime.seconds >= round.deadline;
      const hardCapPassed = chainTime.seconds >= round.opened_at + config.max_round_age_seconds;
      if (deadlinePassed || (hasMin && hardCapPassed)) {
        const reason = deadlinePassed ? "rolling deadline passed" : "hard cap reached with min players";
        console.log(`[${target.label}] round ${roundId} eligible to close (${reason}) - closing`);
        await sendExecute(keeper, target.address, { close_round: {} });
      } else if (!hasMin && hardCapPassed) {
        // Ronda 11 finding (Opus, pre-mainnet audit, 2026-09-08): this branch
        // was missing entirely - a round that never reaches min_players was
        // stuck open forever, since BuyTicket itself starts rejecting tickets
        // once stale but nothing ever called ExpireRound to move the game
        // forward. Mirrors tickCyolRaffle's own expire_raffle branch below.
        console.log(`[${target.label}] round ${roundId} never reached min_players and hard cap elapsed - expiring`);
        await sendExecute(keeper, target.address, { expire_round: {} }, { quiet: true });
      }
      break;
    }

    if (round.status !== "closed" && round.status !== "expiry_pending") break;
    // closed or expiry_pending - front of REVEAL_QUEUE, needs action.
    await handleClosedOrExpiryPending(
      keeper,
      target.address,
      target.label,
      `wheel-manager:${target.label}:${roundId}`,
      { round_id: roundId },
      round,
      config.max_reveal_age_seconds,
      chainTime
    );
    break;
  }

  setCursor(cursorKey, roundId);
}

async function tickWeeklyRound(
  keeper: ReturnType<typeof loadWallet>,
  target: Target,
  chainTime: { seconds: number; height: number }
) {
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
      const durationElapsed = chainTime.seconds >= week.opened_at + config.round_duration_days * 86400;
      const hasMin = week.unique_player_count >= config.min_players;
      if (durationElapsed && hasMin) {
        console.log(`[${target.label}] week ${weekId} reached its full duration with enough players - closing`);
        await sendExecute(keeper, target.address, { close_week: {} });
      } else if (durationElapsed && !hasMin) {
        // Ronda 11 finding (Opus, pre-mainnet audit, 2026-09-08): see
        // tickWheelManager's matching branch - same missing case, same fix.
        console.log(`[${target.label}] week ${weekId} never reached min_players and duration elapsed - expiring`);
        await sendExecute(keeper, target.address, { expire_week: {} }, { quiet: true });
      }
      break;
    }

    if (week.status !== "closed" && week.status !== "expiry_pending") break;
    await handleClosedOrExpiryPending(
      keeper,
      target.address,
      target.label,
      `weekly-round:${target.label}:${weekId}`,
      { week_id: weekId },
      week,
      config.max_reveal_age_seconds,
      chainTime
    );
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

async function tickCyolRaffle(
  keeper: ReturnType<typeof loadWallet>,
  raffleAddress: string,
  chainTime: { seconds: number; height: number }
) {
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
    // hardcoded and gated.
    if (status.opened_at !== null && chainTime.seconds >= status.opened_at + CYOL_MAX_RAFFLE_AGE_SECONDS_MIRROR) {
      await sendExecute(keeper, raffleAddress, { expire_raffle: {} }, { quiet: true });
    }
    return;
  }

  // Funding/AwaitingCommit: nothing for the keeper to do - waiting on the
  // creator (funding) or a same-transaction SubMsg reply (AwaitingCommit,
  // never actually observable at rest - see RaffleStatus's own doc comment).
  if (status.status === "funding" || status.status === "awaiting_commit") return;

  if (status.status !== "closed" && status.status !== "expiry_pending") return;
  await handleClosedOrExpiryPending(
    keeper,
    raffleAddress,
    `cyol:${raffleAddress}`,
    `cyol:${raffleAddress}`,
    {},
    status,
    CYOL_MAX_REVEAL_AGE_SECONDS_MIRROR,
    chainTime
  );
}

async function tick(keeper: ReturnType<typeof loadWallet>, targets: Target[]) {
  // Deliberately outside the per-target try/catch below but still guarded:
  // an RPC hiccup here (timeout, reset, an HTML error page instead of JSON)
  // used to bubble all the way up to main()'s process.exit(1), killing the
  // whole keeper over a single failed request - systemd restarts it, but
  // that costs a ~20-30s reconnect and, during a longer RPC outage, means
  // the process is crash-looping instead of just retrying next tick.
  let chainTime: { seconds: number; height: number };
  try {
    chainTime = await currentBlockStatus();
  } catch (err) {
    console.error(`tick error: failed to fetch current block status: ${(err as Error).message}`);
    return;
  }
  for (const target of targets) {
    try {
      if (target.type === "wheel-manager") {
        await tickWheelManager(keeper, target, chainTime);
      } else if (target.type === "weekly-round") {
        await tickWeeklyRound(keeper, target, chainTime);
      } else {
        const raffles = await discoverCyolRaffles(target.address);
        for (const raffleAddress of raffles) {
          await tickCyolRaffle(keeper, raffleAddress, chainTime);
        }
      }
    } catch (err) {
      console.error(`[${target.label}] tick error: ${(err as Error).message}`);
    }
  }
}

// Round-review fix (Fable, commit_pusher audit round, 2026-08-30): this used
// to silently fall back to ADMIN_MNEMONIC when KEEPER_MNEMONIC wasn't set -
// a production deploy that forgot to set it would start this always-on,
// internet-exposed process with the real admin key with no error and no
// warning, defeating the exact keeper/admin separation this project's
// commit_pusher role split exists to model. Confirm the loaded wallet isn't
// actually admin (or commit_pusher) on any watched contract before starting
// the poll loop - covers all 3 target types (the CYOL factory's GetConfig
// didn't expose admin/commit_pusher until this same round, see its
// query.rs). Kept as defense-in-depth below even though loadWallet's own
// requireEnv (see keeperMainnet.ts's CodeRabbit round, 2026-09-19) now
// refuses to start at all without KEEPER_MNEMONIC explicitly set - this
// assertion still matters if KEEPER_MNEMONIC is ever set to the wrong
// wallet by mistake, and it's the reason discoverTargets() returning an
// incomplete target list (e.g. a deployment file it doesn't recognize) is
// itself dangerous: a target this loop never sees is a target this
// assertion never checks either.
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
  const keeper = loadWallet("KEEPER_MNEMONIC");
  console.log("Keeper address:", keeper.address);

  const targets = discoverTargets();
  // A missing/misplaced deployment file (wrong directory, typo) used to
  // start this always-on process successfully with nothing to actually
  // watch - it would look like it's running fine forever while silently
  // never processing anything (CodeRabbit finding, 2026-09-19 review,
  // fourth round). Refuse to start instead.
  if (targets.length === 0) {
    throw new Error(
      `discoverTargets() found 0 contracts in ${SCRIPTS_DIR} - refusing to start an always-on process that would watch nothing. Check the deployment-*.json files are in this directory.`
    );
  }
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
