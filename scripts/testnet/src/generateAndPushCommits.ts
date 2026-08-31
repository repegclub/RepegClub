// Low-frequency operator tool: generates fresh preimages offline, pushes
// their commits (sha256(preimage)) to every discovered wheel-manager/
// weekly-round/cyol-factory queue via PushCommits, stores the
// (commit -> preimage) pairs locally for keeper.ts to reveal with later, and
// (wheel-manager/weekly-round only) assigns one to the current round/week if
// it doesn't have one yet - BuyTicket/BuyWeeklyTicket refuse to sell before
// that happens, so without this a fresh round with an empty queue would sit
// unbuyable until someone manually calls AssignCommit.
//
// Deliberately separate from keeper.ts (which runs 24/7 on an exposed VM):
// this is meant to be run periodically (a systemd timer on that same VM, see
// repeg-keeper-seed.timer) using COMMIT_PUSHER_MNEMONIC - a wallet that can
// ONLY call PushCommits (see the 3 contracts' new `commit_pusher` role) and
// holds none of admin's other privileges. See the project's Obsidian notes
// ("Grinding vía SubMsg+reply") for why this is a separate wallet and a
// separate script from the always-on keeper process. AssignCommit itself is
// permissionless, so this reuses the same low-privilege pusher wallet for it
// too - no reason to also put an admin key on the always-on box for this.
//
// Usage: npm run generate-and-push-commits -- [count]
// (count defaults to 20 per target, capped at each contract's own
// PUSH_COMMITS_MAX_BATCH=50; safe to re-run anytime - a target whose queue is
// already full via MAX_COMMIT_QUEUE_LEN just logs and is skipped.)

import { randomBytes, createHash } from "crypto";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";
import { discoverTargets } from "./keeperTargets";
import { addSecrets, findPreimage } from "./keeperSecrets";

const DEFAULT_COUNT = 20;
// Matches every contract's own PUSH_COMMITS_MAX_BATCH - a batch bigger than
// this gets rejected outright by PushCommits, wasting the whole tx's gas.
const MAX_BATCH = 50;

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

async function main() {
  const count = parseCount(process.argv[2]);
  const pusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  console.log("commit_pusher address:", pusher.address);

  const targets = discoverTargets();
  console.log(`Found ${targets.length} target(s):`, targets.map((t) => `${t.type}:${t.label}`).join(", "));

  for (const target of targets) {
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
        continue;
      }
      console.log(`[${target.label}] pushed ${pairs.length} commits, tx: ${res.txResponse.txhash}`);
    } catch (err) {
      console.error(`[${target.label}] broadcast error: ${(err as Error).message}`);
      continue;
    }

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
