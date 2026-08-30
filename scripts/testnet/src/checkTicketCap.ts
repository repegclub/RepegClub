import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";
import { addSecrets } from "./keeperSecrets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-cap-test.json"), "utf8")
  );
  console.log("Wheel Manager (cap-test, max_players=4 -> cap=2):", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const commitPusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  const player1 = loadWallet("PLAYER1_MNEMONIC");

  // v9: BuyTicket refuses to sell before the round has a commit assigned.
  const round = await queryContract<{ commit_used: string | null }>(RPC, {
    address: contractAddress,
    query: { get_current_round: {} },
  });
  if (!round.commit_used) {
    // Preimage kept and persisted (round-review fix, CodeRabbit 2026-08-30):
    // this script never reveals anything itself, but discarding it here
    // would leave an un-revealable commit in the shared COMMIT_QUEUE - any
    // round that later consumes it could never be revealed without the
    // 3-phase outage safety net.
    const preimage = randomBytes(32);
    const commit = createHash("sha256").update(preimage).digest("hex");
    const pushRes = await commitPusher.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: commitPusher.address,
          contract: contractAddress,
          msg: { push_commits: { commits: [commit] } },
          funds: [],
        }),
      ],
    });
    if (pushRes.txResponse.code !== 0) throw new Error(`push_commits failed: ${pushRes.txResponse.rawLog}`);
    addSecrets([{ commit, preimage: preimage.toString("hex") }]);
    const assignRes = await admin.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({ sender: admin.address, contract: contractAddress, msg: { assign_commit: {} }, funds: [] }),
      ],
    });
    if (assignRes.txResponse.code !== 0) throw new Error(`assign_commit failed: ${assignRes.txResponse.rawLog}`);
    console.log("Committed and assigned to the current round.");
  }

  for (let i = 1; i <= 3; i++) {
    try {
      const res = await player1.broadcastTxSync({
        msgs: [
          new MsgExecuteContract({
            sender: player1.address,
            contract: contractAddress,
            msg: { buy_ticket: {} },
            funds: [{ denom: "uluna", amount: "1000000" }],
          }),
        ],
      });
      if (res.txResponse.code !== 0) {
        console.log(`Ticket #${i}: FAILED - ${res.txResponse.rawLog}`);
      } else {
        console.log(`Ticket #${i}: ok | gasUsed: ${res.txResponse.gasUsed}`);
      }
    } catch (err) {
      console.log(`Ticket #${i}: rejected during simulation - ${(err as Error).message.slice(0, 150)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
