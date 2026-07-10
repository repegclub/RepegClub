import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ADMIN_FEE_ADDRESS, TREASURY_ADDRESS, loadWallet } from "./config";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/wheel-manager/artifacts/wheel_manager.wasm"
);

// node src/deployWheelManager.ts <label> <maxPlayers> <minPlayers>
const [, , label, maxPlayersArg, minPlayersArg] = process.argv;
if (!label || !maxPlayersArg || !minPlayersArg) {
  console.error("Usage: tsx src/deployWheelManager.ts <label> <maxPlayers> <minPlayers>");
  process.exit(1);
}
const maxPlayers = Number(maxPlayersArg);
const minPlayers = Number(minPlayersArg);
const deploymentPath = path.resolve(__dirname, `../deployment-wheelmanager-${label}.json`);
const weeklyStubDeploymentPath = path.resolve(__dirname, "../deployment-weekly-stub.json");

async function main() {
  const { contractAddress: weeklyRoundAddress } = JSON.parse(
    readFileSync(weeklyStubDeploymentPath, "utf8")
  );
  console.log("Weekly-round-stub address:", weeklyRoundAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin address:", admin.address);

  const wasmByteCode = new Uint8Array(readFileSync(WASM_PATH));
  console.log(`Storing wheel-manager code (${wasmByteCode.length} bytes)...`);

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
        label: `wheel-manager-${label}`,
        msg: {
          ticket_price: "1000000",
          ticket_denom: "uluna",
          redemption_denom: "uluna",
          min_players: minPlayers,
          max_players: maxPlayers,
          round_timeout_seconds: 3600,
          draw_delay_blocks: 2,
          unclaimed_deadline_days: 0,
          treasury_address: TREASURY_ADDRESS,
          admin_fee_address: ADMIN_FEE_ADDRESS,
          weekly_round_address: weeklyRoundAddress,
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
  console.log(`Wheel Manager (${label}) address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(
    deploymentPath,
    JSON.stringify({ codeId: codeId.toString(), contractAddress, maxPlayers, minPlayers }, null, 2)
  );
  console.log("Saved to", deploymentPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
