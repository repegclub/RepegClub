import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, getNativeBalances, queryContract } from "@goblinhunt/cosmes/client";

import { ADMIN_FEE_ADDRESS, RPC, TREASURY_ADDRESS, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// node src/playWheelManagerFlow.ts <label> <numPlayers>
const [, , label, numPlayersArg] = process.argv;
if (!label || !numPlayersArg) {
  console.error("Usage: tsx src/playWheelManagerFlow.ts <label> <numPlayers>");
  process.exit(1);
}
const numPlayers = Number(numPlayersArg);

const deploymentPath = path.resolve(__dirname, `../deployment-wheelmanager-${label}.json`);
const weeklyStubDeploymentPath = path.resolve(__dirname, "../deployment-weekly-stub.json");

async function ulunaBalance(address: string): Promise<bigint> {
  const balances = await getNativeBalances(RPC, { address });
  const uluna = balances.find((c) => c.denom === "uluna");
  return uluna ? BigInt(uluna.amount) : 0n;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { contractAddress } = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const { contractAddress: weeklyStubAddress } = JSON.parse(
    readFileSync(weeklyStubDeploymentPath, "utf8")
  );
  console.log(`Wheel Manager (${label}): ${contractAddress}`);
  console.log("Weekly-round-stub:", weeklyStubAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const playerEnvVars = ["PLAYER1_MNEMONIC", "PLAYER2_MNEMONIC", "PLAYER3_MNEMONIC"].slice(
    0,
    numPlayers
  );
  const players = playerEnvVars.map((v) => loadWallet(v));

  const [treasuryBefore, adminFeeBefore, weeklyBefore] = await Promise.all([
    ulunaBalance(TREASURY_ADDRESS),
    ulunaBalance(ADMIN_FEE_ADDRESS),
    queryContract<{ total: string }>(RPC, { address: weeklyStubAddress, query: { get_total: {} } }),
  ]);

  for (const player of players) {
    console.log(`\n${player.address} buying ticket...`);
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
    const autoClosed = res.txResponse.events
      .find((e) => e.type === "wasm")
      ?.attributes.find((a) => a.key === "auto_closed")?.value;
    console.log(`  ok | gasUsed: ${res.txResponse.gasUsed} | auto_closed: ${autoClosed}`);
  }

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
      console.log(`  attempt ${attempt} not ready yet, waiting 6s... (${(err as Error).message.slice(0, 80)})`);
      drawRes = undefined;
      await sleep(6000);
    }
  }
  if (!drawRes || drawRes.txResponse.code !== 0) {
    throw new Error("draw_winner never succeeded after retries");
  }
  const wasmEvent = drawRes.txResponse.events.find((e) => e.type === "wasm");
  const winner = wasmEvent?.attributes.find((a) => a.key === "winner")?.value;
  const prize = wasmEvent?.attributes.find((a) => a.key === "prize")?.value;
  if (!winner || !prize) throw new Error("winner/prize not found in draw_winner events");
  console.log(`Winner: ${winner} | prize: ${prize} uluna | gasUsed: ${drawRes.txResponse.gasUsed}`);

  const winnerWallet = players.find((p) => p.address === winner);
  if (!winnerWallet) throw new Error("winner is not one of our loaded player wallets");

  console.log(`\n${winner} redeeming round 1...`);
  const redeemRes = await winnerWallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: winner,
        contract: contractAddress,
        msg: { redeem: { round_id: 1 } },
        funds: [{ denom: "uluna", amount: prize }],
      }),
    ],
  });
  if (redeemRes.txResponse.code !== 0) {
    throw new Error(`redeem failed: ${redeemRes.txResponse.rawLog}`);
  }
  console.log(`Redeemed | gasUsed: ${redeemRes.txResponse.gasUsed}`);

  const [treasuryAfter, adminFeeAfter, weeklyAfter] = await Promise.all([
    ulunaBalance(TREASURY_ADDRESS),
    ulunaBalance(ADMIN_FEE_ADDRESS),
    queryContract<{ total: string }>(RPC, { address: weeklyStubAddress, query: { get_total: {} } }),
  ]);

  const grossPool = BigInt(numPlayers) * 1_000_000n;
  console.log("\n=== REPORT ===");
  console.log(`Players: ${numPlayers} | gross pool: ${grossPool} uluna`);
  console.log(`Prize paid to winner: ${prize} uluna (expected 60%: ${(grossPool * 60n) / 100n})`);
  console.log(
    `Treasury delta: ${treasuryAfter - treasuryBefore} uluna (expected 12%+dust: ~${(grossPool * 12n) / 100n})`
  );
  console.log(
    `Admin fee delta: ${adminFeeAfter - adminFeeBefore} uluna (expected 3%: ${(grossPool * 3n) / 100n})`
  );
  console.log(
    `Weekly-stub delta: ${BigInt(weeklyAfter.total) - BigInt(weeklyBefore.total)} uluna (expected 20%: ${(grossPool * 20n) / 100n})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
