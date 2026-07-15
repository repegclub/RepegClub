import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-frontenddev2.json"), "utf8")
  );
  console.log("Wheel Manager (frontenddev2):", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");

  const purchases: [ReturnType<typeof loadWallet>, number][] = [
    [admin, 3],
    [player1, 1],
    [player2, 2],
  ];

  for (const [wallet, count] of purchases) {
    for (let i = 0; i < count; i++) {
      const res = await wallet.broadcastTxSync({
        msgs: [
          new MsgExecuteContract({
            sender: wallet.address,
            contract: contractAddress,
            msg: { buy_ticket: {} },
            funds: [{ denom: "uluna", amount: "1000000" }],
          }),
        ],
      });
      if (res.txResponse.code !== 0) throw new Error(`buy_ticket failed: ${res.txResponse.rawLog}`);
      console.log(`${wallet.address} bought ticket ${i + 1}/${count} | gasUsed: ${res.txResponse.gasUsed}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
