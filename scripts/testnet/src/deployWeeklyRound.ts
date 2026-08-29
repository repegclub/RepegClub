import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ADMIN_FEE_ADDRESS, TREASURY_ADDRESS, loadWallet } from "./config";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/weekly-round/artifacts/weekly_round.wasm"
);
const DEPLOYMENT_PATH = path.resolve(__dirname, "../deployment-weekly-round.json");

async function main() {
  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin address:", admin.address);

  // See Config::commit_pusher's own doc comment - a role separate from
  // admin, gating only PushCommits. Only its address is needed here (never
  // signs anything in this script).
  const commitPusherAddress = loadWallet("COMMIT_PUSHER_MNEMONIC").address;
  console.log("commit_pusher address:", commitPusherAddress);

  const wasmByteCode = new Uint8Array(readFileSync(WASM_PATH));
  console.log(`Storing weekly-round code (${wasmByteCode.length} bytes)...`);

  const storeRes = await admin.broadcastTxSync({
    msgs: [new MsgStoreCode({ sender: admin.address, wasmByteCode })],
  });
  if (storeRes.txResponse.code !== 0) {
    throw new Error(`Store failed: ${storeRes.txResponse.rawLog}`);
  }
  const codeIdAttr = storeRes.txResponse.events
    .find((e) => e.type === "store_code")
    ?.attributes.find((a) => a.key === "code_id");
  if (!codeIdAttr) throw new Error("code_id not found in store_code tx events");
  const codeId = BigInt(codeIdAttr.value);
  console.log(`Code ID: ${codeId} | gasUsed: ${storeRes.txResponse.gasUsed}`);

  const instRes = await admin.broadcastTxSync({
    msgs: [
      new MsgInstantiateContract({
        sender: admin.address,
        codeId,
        label: "weekly-round",
        msg: {
          base_ticket_price: "10000000",
          price_increment_per_day: "1000000",
          ticket_denom: "uluna",
          redemption_denom: "uluna",
          min_players: 2,
          max_players: 10,
          // Real "weekly" duration - was 1 (a day) as a testing shortcut to
          // iterate fast.
          round_duration_days: 7,
          // See wheel-manager's matching deploy script for the 1-hour default
          // rationale (max_reveal_age_seconds, bounded 30min-7days).
          max_reveal_age_seconds: 3600,
          unclaimed_deadline_days: 90,
          treasury_address: TREASURY_ADDRESS,
          admin_fee_address: ADMIN_FEE_ADDRESS,
          commit_pusher: commitPusherAddress,
        },
        funds: [],
      }),
    ],
  });
  if (instRes.txResponse.code !== 0) {
    throw new Error(`Instantiate failed: ${instRes.txResponse.rawLog}`);
  }
  const addrAttr = instRes.txResponse.events
    .find((e) => e.type === "instantiate")
    ?.attributes.find((a) => a.key === "_contract_address");
  if (!addrAttr) throw new Error("contract address not found in instantiate tx events");
  const contractAddress = addrAttr.value;
  console.log(`Weekly Round address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(DEPLOYMENT_PATH, JSON.stringify({ codeId: codeId.toString(), contractAddress }, null, 2));
  console.log("Saved to", DEPLOYMENT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
