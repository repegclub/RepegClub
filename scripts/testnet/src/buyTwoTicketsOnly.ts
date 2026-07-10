import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-keeper-test2.json"), "utf8")
  );
  console.log("Wheel Manager (keeper-test):", contractAddress);

  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");

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
  console.log("Round should now be auto-closed (max_players=2). Leaving it for the keeper to draw.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
