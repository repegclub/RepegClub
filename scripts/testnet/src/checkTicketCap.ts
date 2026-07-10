import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-cap-test.json"), "utf8")
  );
  console.log("Wheel Manager (cap-test, max_players=4 -> cap=2):", contractAddress);

  const player1 = loadWallet("PLAYER1_MNEMONIC");

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
