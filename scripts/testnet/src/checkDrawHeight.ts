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
  const admin = loadWallet("ADMIN_MNEMONIC");

  try {
    const closeRes = await admin.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: admin.address,
          contract: contractAddress,
          msg: { close_round: {} },
          funds: [],
        }),
      ],
    });
    console.log("CloseRound ok | gasUsed:", closeRes.txResponse.gasUsed);
  } catch (err) {
    console.log(`CloseRound skipped (likely already closed): ${(err as Error).message.slice(0, 100)}`);
  }

  let drawRes;
  for (let attempt = 1; attempt <= 10; attempt++) {
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
      console.log(`draw attempt ${attempt} not ready: ${(err as Error).message.slice(0, 100)}`);
      drawRes = undefined;
      await sleep(6000);
    }
  }
  if (!drawRes || drawRes.txResponse.code !== 0) throw new Error("draw_winner never succeeded");
  const roundIdAttr = drawRes.txResponse.events
    .find((e) => e.type === "wasm")
    ?.attributes.find((a) => a.key === "round_id");
  console.log("DrawWinner ok, round_id:", roundIdAttr?.value, "| gasUsed:", drawRes.txResponse.gasUsed);

  const drawnRound = await queryContract<{
    status: string;
    draw_height: number | null;
    draw_after_height: number | null;
    winner: string;
  }>(RPC, {
    address: contractAddress,
    query: { get_round_history: { round_id: Number(roundIdAttr?.value) } },
  });
  console.log("Drawn round:", drawnRound.status, "winner:", drawnRound.winner);
  console.log("draw_after_height (minimum):", drawnRound.draw_after_height);
  console.log("draw_height (actual, used in the hash):", drawnRound.draw_height);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
