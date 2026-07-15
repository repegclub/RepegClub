import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-frontenddev4.json"), "utf8")
  );
  console.log("Wheel Manager (frontenddev4, max_round_age_seconds=180):", contractAddress);

  const player1 = loadWallet("PLAYER1_MNEMONIC");

  const round = await queryContract<{ round_id: number }>(RPC, {
    address: contractAddress,
    query: { get_current_round: {} },
  });
  console.log("Current round before buying:", round.round_id);

  const buyRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      }),
    ],
  });
  if (buyRes.txResponse.code !== 0) throw new Error(`buy_ticket failed: ${buyRes.txResponse.rawLog}`);
  console.log("player1 bought 1 ticket (min_players=2, alone in this round).");

  // ExpireRound should fail immediately - max_round_age_seconds (180s) hasn't elapsed.
  try {
    const tooEarly = await player1.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: player1.address,
          contract: contractAddress,
          msg: { expire_round: {} },
          funds: [],
        }),
      ],
    });
    console.log(
      tooEarly.txResponse.code !== 0
        ? `ExpireRound too early, correctly rejected: ${tooEarly.txResponse.rawLog.slice(0, 120)}`
        : "UNEXPECTED: ExpireRound succeeded too early"
    );
  } catch (err) {
    console.log(`ExpireRound too early, correctly rejected during simulation: ${(err as Error).message.slice(0, 120)}`);
  }

  console.log("Waiting 185s for max_round_age_seconds (180s) to elapse...");
  await sleep(185_000);

  const expireRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { expire_round: {} },
        funds: [],
      }),
    ],
  });
  if (expireRes.txResponse.code !== 0) throw new Error(`expire_round failed: ${expireRes.txResponse.rawLog}`);
  console.log("ExpireRound ok | gasUsed:", expireRes.txResponse.gasUsed);

  const round1 = await queryContract<{
    status: string;
    pool: string;
    expired_at: number | null;
  }>(RPC, { address: contractAddress, query: { get_round_history: { round_id: round.round_id } } });
  console.log("Round 1 after expiry:", round1.status, "pool:", round1.pool, "expired_at:", round1.expired_at);

  const currentRound = await queryContract<{ round_id: number; status: string }>(RPC, {
    address: contractAddress,
    query: { get_current_round: {} },
  });
  console.log("New current round opened automatically:", currentRound.round_id, currentRound.status);

  const reclaimRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { reclaim_ticket: { round_id: round.round_id } },
        funds: [],
      }),
    ],
  });
  if (reclaimRes.txResponse.code !== 0) throw new Error(`reclaim_ticket failed: ${reclaimRes.txResponse.rawLog}`);
  const amountAttr = reclaimRes.txResponse.events
    .find((e) => e.type === "wasm")
    ?.attributes.find((a) => a.key === "amount");
  console.log("ReclaimTicket ok | refunded amount:", amountAttr?.value, "| gasUsed:", reclaimRes.txResponse.gasUsed);

  // Reclaiming a second time should fail - nothing left for this wallet.
  try {
    const secondReclaim = await player1.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: player1.address,
          contract: contractAddress,
          msg: { reclaim_ticket: { round_id: round.round_id } },
          funds: [],
        }),
      ],
    });
    console.log(
      secondReclaim.txResponse.code !== 0
        ? `Second reclaim correctly rejected: ${secondReclaim.txResponse.rawLog.slice(0, 120)}`
        : "UNEXPECTED: second reclaim succeeded"
    );
  } catch (err) {
    console.log(`Second reclaim correctly rejected during simulation: ${(err as Error).message.slice(0, 120)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
