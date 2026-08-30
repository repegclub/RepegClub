import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, getNativeBalances } from "@goblinhunt/cosmes/client";

import { TREASURY_ADDRESS, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ulunaBalance(address: string): Promise<bigint> {
  const balances = await getNativeBalances("https://rpc.terra-classic.hexxagon.dev", { address });
  const uluna = balances.find((c) => c.denom === "uluna");
  return uluna ? BigInt(uluna.amount) : 0n;
}

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-sweep-test.json"), "utf8")
  );
  console.log("Wheel Manager (sweep-test):", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const commitPusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");
  const player3 = loadWallet("PLAYER3_MNEMONIC"); // uninvolved bystander, will trigger the sweep

  // v9: BuyTicket refuses to sell before the round has a commit assigned.
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
  const assignRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({ sender: admin.address, contract: contractAddress, msg: { assign_commit: {} }, funds: [] }),
    ],
  });
  if (assignRes.txResponse.code !== 0) throw new Error(`assign_commit failed: ${assignRes.txResponse.rawLog}`);
  console.log("Committed and assigned to round 1.");

  for (const player of [player1, player2]) {
    const res = await player.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: player.address,
          contract: contractAddress,
          msg: { buy_ticket: {} },
          funds: [{ denom: "uluna", amount: "1000000" }],
        }),
      ],
    });
    if (res.txResponse.code !== 0) throw new Error(`buy_ticket failed: ${res.txResponse.rawLog}`);
    console.log(`${player.address} bought a ticket | gasUsed: ${res.txResponse.gasUsed}`);
  }

  console.log("\nRevealing draw...");
  const drawRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: contractAddress,
        msg: { reveal_draw: { round_id: 1, preimage: preimage.toString("hex") } },
        funds: [],
      }),
    ],
  });
  if (drawRes.txResponse.code !== 0) throw new Error(`reveal_draw failed: ${drawRes.txResponse.rawLog}`);
  console.log(`Drawn | gasUsed: ${drawRes.txResponse.gasUsed}`);

  // Deliberately do NOT redeem - simulate a winner who never claims.
  console.log("\nBystander (player3) sweeps the never-claimed prize to the treasury...");
  const treasuryBefore = await ulunaBalance(TREASURY_ADDRESS);

  const sweepRes = await player3.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player3.address,
        contract: contractAddress,
        msg: { sweep_expired_prize: { round_id: 1 } },
        funds: [],
      }),
    ],
  });
  if (sweepRes.txResponse.code !== 0) throw new Error(`sweep_expired_prize failed: ${sweepRes.txResponse.rawLog}`);
  console.log(`Swept | gasUsed: ${sweepRes.txResponse.gasUsed}`);

  const treasuryAfter = await ulunaBalance(TREASURY_ADDRESS);
  console.log("\n=== REPORT ===");
  console.log(`Treasury delta: ${treasuryAfter - treasuryBefore} uluna (expected: 1200000, the 60% prize of a 2_000_000 pool)`);
  console.log("Swept by a bystander wallet (player3), not the admin - confirms the sweep is permissionless.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
