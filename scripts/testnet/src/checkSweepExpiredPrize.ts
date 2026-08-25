import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, getNativeBalances, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, TREASURY_ADDRESS, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ulunaBalance(address: string): Promise<bigint> {
  const balances = await getNativeBalances("https://rpc.terra-classic.hexxagon.dev", { address });
  const uluna = balances.find((c) => c.denom === "uluna");
  return uluna ? BigInt(uluna.amount) : 0n;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This script assumes deployment-wheelmanager-sweep-test.json was
// instantiated with unclaimed_deadline_days: 0, so the final sweep_expired_prize
// call below runs immediately with no wait - that value is no longer
// accepted (MIN_UNCLAIMED_DEADLINE_DAYS = 1, 2026-08-24 instantiate bounds
// fix). Redeploying this test contract now means the sweep below won't
// succeed until unclaimed_deadline_days (at least 1 day) has actually
// elapsed - either wait a day between redeploy and running this script, or
// mock forward time if run against a local/test environment that supports it.
async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-sweep-test.json"), "utf8")
  );
  console.log("Wheel Manager (sweep-test):", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");
  const player3 = loadWallet("PLAYER3_MNEMONIC"); // uninvolved bystander, will trigger the sweep

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

  // With max_players=2 == min_players=2, the second buy_ticket above already
  // drew the winner atomically (2026-08-24 audit fix - see execute.rs) - no
  // separate DrawWinner call is possible for round 1 anymore. Check first
  // instead of assuming the old separate-call flow.
  const round1 = await queryContract<{ status: string }>(RPC, {
    address: contractAddress,
    query: { get_round_history: { round_id: 1 } },
  });
  if (round1.status === "drawn") {
    console.log("\nRound 1 already drawn atomically by the closing ticket purchase - skipping DrawWinner.");
  } else {
    console.log("\nDrawing winner (retrying until draw_delay_blocks has passed)...");
    let drawRes;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        drawRes = await admin.broadcastTxSync({
          msgs: [
            new MsgExecuteContract({
              sender: admin.address,
              contract: contractAddress,
              msg: { draw_winner: {} },
              funds: [],
            }),
          ],
        });
        if (drawRes.txResponse.code === 0) break;
        throw new Error(drawRes.txResponse.rawLog);
      } catch (err) {
        console.log(`  attempt ${attempt} not ready yet, waiting 6s...`);
        drawRes = undefined;
        await sleep(6000);
      }
    }
    if (!drawRes || drawRes.txResponse.code !== 0) throw new Error("draw_winner never succeeded");
    console.log(`Drawn | gasUsed: ${drawRes.txResponse.gasUsed}`);
  }

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
