// Low-frequency operator tool: generates fresh preimages offline, pushes
// their commits (sha256(preimage)) to every discovered wheel-manager/
// weekly-round/cyol-factory queue via PushCommits, stores the
// (commit -> preimage) pairs locally for keeperMainnet.ts to reveal with
// later, and (wheel-manager/weekly-round only) assigns one to the current
// round/week if it doesn't have one yet - BuyTicket/BuyWeeklyTicket refuse
// to sell before that happens, so without this a fresh round with an empty
// queue would sit unbuyable until someone manually calls AssignCommit.
//
// Real mainnet variant of generateAndPushCommits.ts - only real difference
// is the ./config import below (testnet -> ./configMainnet), same reasoning
// as every other Mainnet-suffixed script in this project. Meant to run from
// its own separate directory on the VM (not the same one as the testnet
// keeper/seeder) using COMMIT_PUSHER_MNEMONIC - a wallet that can ONLY call
// PushCommits (see the 3 contracts' new `commit_pusher` role) and holds none
// of admin's other privileges. See the project's Obsidian notes ("Grinding
// vía SubMsg+reply") for why this is a separate wallet and a separate script
// from the always-on keeper process. AssignCommit itself is permissionless,
// so this reuses the same low-privilege pusher wallet for it too - no reason
// to also put an admin key on the always-on box for this.
//
// Usage: npm run mainnet:generate-and-push-commits -- [count]
// (count defaults to 20 per target, capped at each contract's own
// PUSH_COMMITS_MAX_BATCH=50; safe to re-run anytime - a target whose queue
// already has LOW_WATER_MARK or more commits queued is skipped without
// spending any gas, see commitQueueLen below.)

import { randomBytes, createHash } from "crypto";

import { base16, base64 } from "@goblinhunt/cosmes/codec";
import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";
import { CosmwasmWasmV1QueryRawContractStateService as RawContractStateService } from "@goblinhunt/cosmes/protobufs";

import { RPC, loadWallet } from "./configMainnet";
import { discoverTargets, SCRIPTS_DIR } from "./keeperTargets";
import { addSecrets, findPreimage } from "./keeperSecrets";

const DEFAULT_COUNT = 20;
// Matches every contract's own PUSH_COMMITS_MAX_BATCH - a batch bigger than
// this gets rejected outright by PushCommits, wasting the whole tx's gas.
const MAX_BATCH = 50;

// Real incident, 2026-09-01 (testnet): a version of this script used to push
// a fresh batch to every target on every run, with no check for whether the
// queue actually needed it - each successful push costs real gas (~10 LUNC
// on testnet's own gas price, this chain's is unusually high), and a
// systemd timer running every 10 minutes silently burned through
// commit_pusher's balance for over a day before anyone noticed. Below this
// many commits already queued, skip the push entirely rather than relying
// on the contract's own MAX_COMMIT_QUEUE_LEN rejection - a rejected
// push_commits still gets broadcast and still costs the fee, since
// CommitQueueFull is a normal contract-level error, not a fee-payer check
// like insufficient funds (which is why those specific failures cost
// nothing - they never left this machine). AssignCommit is unaffected by
// this - it already checks commit_used before spending gas, so it's left as-
// is below.
const LOW_WATER_MARK = 20;

// Round-review fix (CodeRabbit, 2026-08-30): an unparseable, negative, or
// oversized count used to pass straight through to generateCommits/PushCommits
// with no validation.
function parseCount(arg: string | undefined): number {
  if (arg === undefined) return DEFAULT_COUNT;
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`count must be a positive integer, got: ${arg}`);
  }
  return Math.min(n, MAX_BATCH);
}

function generateCommits(count: number): { commit: string; preimage: string }[] {
  const pairs = [];
  for (let i = 0; i < count; i++) {
    const preimage = randomBytes(32);
    const commit = createHash("sha256").update(preimage).digest();
    pairs.push({ commit: commit.toString("hex"), preimage: preimage.toString("hex") });
  }
  return pairs;
}

// COMMIT_QUEUE (see contracts/*/src/state.rs, identical namespace on all 3
// contracts) is a cw-storage-plus 1.2.0 Deque<HexBinary>, which stores its
// length as two big-endian u32 "meta keys" - head/tail - under a
// length-prefixed "commit_queue" namespace (see that crate's deque.rs:
// namespaces_with_key/encode_length/read_meta_key). Reading them directly
// via RawContractState lets this script check queue depth before spending
// gas to push more, without needing a dedicated contract query (which would
// mean a Rust change and a redeploy of contracts this project already has
// live rounds/rifas on).
function dequeMetaKey(metaByte: "h" | "t"): Uint8Array {
  const namespace = new TextEncoder().encode("commit_queue");
  const key = new TextEncoder().encode(metaByte);
  const out = new Uint8Array(2 + namespace.length + key.length);
  out[0] = (namespace.length >> 8) & 0xff;
  out[1] = namespace.length & 0xff;
  out.set(namespace, 2);
  out.set(key, 2 + namespace.length);
  return out;
}

// Plain Tendermint RPC abci_query POST - the same JSON-RPC shape
// RpcClient.doRequest uses internally (a private method, not part of the
// library's public API), reimplemented here rather than reached into.
async function abciQuery(path: string, dataHex: string): Promise<{ value: string; log: string }> {
  // Bounded deadline so a stalled RPC can't hang this indefinitely -
  // commitQueueLen() is awaited inside main()'s per-target loop, so a stall
  // here would block every later target from running (CodeRabbit finding,
  // 2026-09-19 review, fourth round). The timeout rejection is caught by
  // that loop's existing try/catch same as any other fetch failure.
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: Date.now(), jsonrpc: "2.0", method: "abci_query", params: { path, data: dataHex } }),
    signal: AbortSignal.timeout(10_000),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.data);
  // A nonzero ABCI response `code` (an application-level query error) is a
  // separate failure channel from the JSON-RPC `error` above, and CometBFT
  // returns it with an empty `value` - readDequeMeta's own "empty value
  // means an untouched key" fallback can't tell that apart from a genuine
  // error without this check (CodeRabbit, PR #53).
  if (result.response.code) throw new Error(`abci_query failed (code ${result.response.code}): ${result.response.log}`);
  return result.response;
}

async function readDequeMeta(address: string, metaByte: "h" | "t"): Promise<number> {
  // Deliberately NOT RpcClient.query() (the generic wrapper used everywhere
  // else in this project) - it treats an empty `value` in the abci_query
  // response as an error and throws, which is wrong here: an absent key
  // (empty value) is the correct, expected response for a Deque that's
  // never been touched, not a failure. Found live, 2026-09-10, seeding a
  // freshly deployed mainnet contract whose commit_queue had never been
  // written to even once - every prior use of this script (testnet) had
  // already-touched queues, so this dormant bug never triggered before.
  const { typeName, method, Request, Response } = RawContractStateService;
  const data = base16.encode(new Request({ address, queryData: dequeMetaKey(metaByte) }).toBinary());
  const response = await abciQuery(`/${typeName}/${method}`, data);
  if (!response.value) return 0;
  // response.value is a serialized QueryRawContractStateResponse, not the
  // raw storage bytes directly - its `data` field is. Reading getUint32
  // straight off response.value (as a previous version of this function
  // did) picks up that message's own protobuf tag+length header (0x0a 0x04)
  // as the top 2 bytes, always producing the same wrong constant (168034304)
  // whenever the key has any value at all - which made every already-seeded
  // queue look empty to the LOW_WATER_MARK check below, defeating it
  // silently (found live, 2026-09-18, chasing an unexplained gas spend).
  const raw = Response.fromBinary(base64.decode(response.value)).data;
  if (raw.length === 0) return 0;
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, false);
}

async function commitQueueLen(address: string): Promise<number> {
  const [head, tail] = await Promise.all([readDequeMeta(address, "h"), readDequeMeta(address, "t")]);
  return tail - head;
}

async function main() {
  const count = parseCount(process.argv[2]);
  const pusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  console.log("commit_pusher address:", pusher.address);

  const targets = discoverTargets();
  // A missing/misplaced deployment file used to make this exit successfully
  // having pushed nothing, instead of a clear failure (CodeRabbit finding,
  // 2026-09-19 review, fourth round) - the seed timer that runs this on a
  // schedule would just look "green" forever while silently never seeding.
  if (targets.length === 0) {
    throw new Error(
      `discoverTargets() found 0 contracts in ${SCRIPTS_DIR} - refusing to report success without pushing any commits. Check the deployment-*.json files are in this directory.`
    );
  }
  console.log(`Found ${targets.length} target(s):`, targets.map((t) => `${t.type}:${t.label}`).join(", "));

  // If every target's queue-length read fails, this run pushes nothing and
  // used to still exit 0 - the scheduled timer running this would look
  // healthy forever while silently never seeding (CodeRabbit finding,
  // 2026-09-20 review, eighth round). A single target failing among others
  // that succeed stays non-fatal (logged, skipped) - only "the whole run
  // accomplished nothing" throws.
  let queueLenFailures = 0;
  // Same reasoning as queueLenFailures above, one level deeper: if every
  // target that actually NEEDED a push had that push fail, the run still
  // exited 0 (logged only) - the scheduled timer would look healthy while
  // genuinely replenishing nothing (CodeRabbit finding, 2026-09-20 review,
  // tenth round). A target that didn't need a push (queue already full)
  // never touches these counters, so a quiet no-op run stays non-fatal.
  let pushesRequired = 0;
  let pushesSucceeded = 0;
  // Same pattern, one step further (CodeRabbit finding, 2026-09-20 review,
  // eleventh round): commit_used === null means an assignment is required
  // for that round/week - if every required assignment fails, this run
  // looked healthy while leaving every eligible round/week without a
  // commit, same silent-failure risk as the push step above.
  let assignmentsRequired = 0;
  let assignmentsSucceeded = 0;
  for (const target of targets) {
    let currentLen: number;
    try {
      currentLen = await commitQueueLen(target.address);
    } catch (err) {
      console.error(`[${target.label}] queue length read error: ${(err as Error).message}`);
      queueLenFailures++;
      continue;
    }
    if (currentLen >= LOW_WATER_MARK) {
      console.log(`[${target.label}] queue already has ${currentLen} commits queued (>= ${LOW_WATER_MARK}) - skipping push.`);
    } else {
      pushesRequired++;
      const pairs = generateCommits(count);
      // cosmwasm_std::HexBinary (de)serializes as a plain hex string, not
      // base64 (see cosmwasm-std's hex_binary.rs Serialize impl) - unlike
      // cosmwasm_std::Binary, which does use base64.
      const commits = pairs.map((p) => p.commit);
      // Saved before broadcasting, not after checking success (round-review
      // fix, Opus, commit_pusher audit round, 2026-08-30): if broadcastTxSync's
      // own pollTx times out (or the process dies) after the tx already landed
      // on-chain but before this function returns, the old order would lose
      // the preimage for a commit that's already live in COMMIT_QUEUE - that
      // round/week/raffle becomes permanently unrevealable once it's assigned,
      // and blocks REVEAL_QUEUE for everything behind it until the 3-phase
      // expiration cascade completes. Saving a preimage for a commit that
      // never actually lands on-chain is harmless - it just sits as dead
      // weight in the already-gitignored keeper-secrets.json.
      addSecrets(pairs);
      try {
        const res = await pusher.broadcastTxSync({
          msgs: [
            new MsgExecuteContract({
              sender: pusher.address,
              contract: target.address,
              msg: { push_commits: { commits } },
              funds: [],
            }),
          ],
          memo: "REPEG CLUB",
        });
        if (res.txResponse.code !== 0) {
          console.error(`[${target.label}] push_commits failed: ${res.txResponse.rawLog}`);
        } else {
          console.log(`[${target.label}] pushed ${pairs.length} commits, tx: ${res.txResponse.txhash}`);
          pushesSucceeded++;
        }
      } catch (err) {
        console.error(`[${target.label}] broadcast error: ${(err as Error).message}`);
      }
    }

    // Attempted regardless of whether the push above succeeded (round-review
    // fix, CodeRabbit, 2026-09-01): a failed push this run doesn't mean the
    // queue is empty - an earlier successful push may have left commits
    // sitting there unassigned, and there's no reason to wait another
    // LOW_WATER_MARK-and-a-cron-cycle to hand one to the round/week.
    if (target.type !== "wheel-manager" && target.type !== "weekly-round") continue;
    try {
      const current =
        target.type === "wheel-manager"
          ? await queryContract<{ commit_used: string | null }>(RPC, {
              address: target.address,
              query: { get_current_round: {} },
            })
          : await queryContract<{ commit_used: string | null }>(RPC, {
              address: target.address,
              query: { get_current_week: {} },
            });
      if (current.commit_used) continue;
      assignmentsRequired++;
      const assignRes = await pusher.broadcastTxSync({
        msgs: [
          new MsgExecuteContract({ sender: pusher.address, contract: target.address, msg: { assign_commit: {} }, funds: [] }),
        ],
        memo: "REPEG CLUB",
      });
      if (assignRes.txResponse.code !== 0) {
        console.error(`[${target.label}] assign_commit failed: ${assignRes.txResponse.rawLog}`);
        continue;
      }
      assignmentsSucceeded++;
      console.log(`[${target.label}] assigned a commit to the current round/week, tx: ${assignRes.txResponse.txhash}`);
      // The FIFO queue could have handed out a commit pushed earlier by a
      // different machine/session than this one (round-review fix,
      // CodeRabbit, 2026-08-30) - if this box's own keeper-secrets.json
      // never got that preimage, the round is now stuck until the 3-phase
      // outage safety net kicks in. Re-querying confirms exactly which
      // commit got assigned and warns loudly right away instead of only
      // finding out at reveal time.
      const after =
        target.type === "wheel-manager"
          ? await queryContract<{ commit_used: string | null }>(RPC, {
              address: target.address,
              query: { get_current_round: {} },
            })
          : await queryContract<{ commit_used: string | null }>(RPC, {
              address: target.address,
              query: { get_current_week: {} },
            });
      if (after.commit_used && !findPreimage(after.commit_used)) {
        console.error(
          `[${target.label}] WARNING: assigned commit ${after.commit_used} has no locally stored preimage - ` +
            "it was pushed by a different machine/session. This round/week cannot be revealed from here; " +
            "copy that machine's keeper-secrets.json over, or it'll sit until the 3-phase outage safety net."
        );
      }
    } catch (err) {
      console.error(`[${target.label}] assign_commit error: ${(err as Error).message}`);
    }
  }

  if (queueLenFailures === targets.length) {
    throw new Error(
      `Queue-length read failed for all ${targets.length} target(s) - this run pushed nothing. See the errors above.`
    );
  }
  if (pushesRequired > 0 && pushesSucceeded === 0) {
    throw new Error(
      `${pushesRequired} target(s) needed a commit push and none succeeded - this run replenished nothing. See the errors above.`
    );
  }
  if (assignmentsRequired > 0 && assignmentsSucceeded === 0) {
    throw new Error(
      `${assignmentsRequired} target(s) needed a commit assignment and none succeeded - this run assigned nothing. See the errors above.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
