import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// node src/checkCyolOracle.ts <label>
const [, , label] = process.argv;
if (!label) {
  console.error("Usage: tsx src/checkCyolOracle.ts <label>");
  process.exit(1);
}

async function main() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-${label}.json`), "utf8")
  );
  console.log("Create Your Own Luck:", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");

  console.log("\nCalling DepositPrize with a real uluna prize but 0 of the (fake) USTC fee denom...");
  console.log("(this is expected to fail during gas simulation - we're reading the on-chain-computed 'expected fee' out of the error)");

  let rawLog = "";
  try {
    const res = await admin.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: admin.address,
          contract: contractAddress,
          msg: { deposit_prize: {} },
          funds: [{ denom: "uluna", amount: "1000000" }],
        }),
      ],
    });
    rawLog = res.txResponse.rawLog;
    console.log("\ntx code:", res.txResponse.code);
  } catch (err) {
    rawLog = (err as Error).message;
  }
  console.log("error:", rawLog);

  const match = rawLog.match(/expected exactly (\d+)/);
  if (!match) {
    throw new Error("Could not find 'expected exactly <amount>' in the error - the call may have unexpectedly succeeded or failed differently");
  }
  const onChainFee = BigInt(match[1]);

  // Same 2-hop math as price_oracle.rs, computed independently here in JS from
  // the same reserves the mock pools were instantiated with.
  const feeReferenceUsdMicros = 3_000_000n;
  const reserveUstc = 2_000_000n;
  const reserveLuncA = 1_000_000n;
  const reserveLuncB = 1_000_000n;
  const reserveUsdc = 500_000n;
  const luncEquivalent = (feeReferenceUsdMicros * reserveLuncB) / reserveUsdc;
  const expectedFee = (luncEquivalent * reserveUstc) / reserveLuncA;

  console.log("\n=== REPORT ===");
  console.log(`On-chain computed fee (from the live 2-hop smart query): ${onChainFee}`);
  console.log(`Independently computed expected fee (JS, same formula):  ${expectedFee}`);
  console.log(onChainFee === expectedFee ? "MATCH: the on-chain DEX price oracle computed the correct fee." : "MISMATCH - investigate!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
