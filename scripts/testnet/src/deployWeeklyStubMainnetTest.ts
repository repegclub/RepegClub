import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadWallet } from "./configMainnetTest";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/weekly-round-stub/artifacts/weekly_round_stub.wasm"
);
const DEPLOYMENT_PATH = path.resolve(__dirname, "../deployment-weekly-stub-mainnet-test.json");

async function main() {
  const admin = loadWallet("MAINNET_TEST_ADMIN_MNEMONIC");
  console.log("Admin address:", admin.address);

  const wasmByteCode = new Uint8Array(readFileSync(WASM_PATH));
  console.log(`Storing weekly-round-stub code (${wasmByteCode.length} bytes)...`);

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
        label: "weekly-round-stub (MAINNET TAX TEST - disposable)",
        msg: {},
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
  console.log(`Weekly-round-stub address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(
    DEPLOYMENT_PATH,
    JSON.stringify({ codeId: codeId.toString(), contractAddress }, null, 2)
  );
  console.log("Saved to", DEPLOYMENT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
