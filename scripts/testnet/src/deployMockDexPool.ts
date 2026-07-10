import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadWallet } from "./config";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "../../../contracts/mock-dex-pool/artifacts/mock_dex_pool.wasm");

// node src/deployMockDexPool.ts <label> <denomA> <amountA> <denomB> <amountB>
const [, , label, denomA, amountA, denomB, amountB] = process.argv;
if (!label || !denomA || !amountA || !denomB || !amountB) {
  console.error("Usage: tsx src/deployMockDexPool.ts <label> <denomA> <amountA> <denomB> <amountB>");
  process.exit(1);
}
const deploymentPath = path.resolve(__dirname, `../deployment-mock-dex-pool-${label}.json`);
const codeIdCachePath = path.resolve(__dirname, "../deployment-mock-dex-pool-codeid.json");

async function main() {
  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin address:", admin.address);

  let codeId: bigint;
  try {
    const cached = JSON.parse(readFileSync(codeIdCachePath, "utf8"));
    codeId = BigInt(cached.codeId);
    console.log("Reusing cached code_id:", codeId.toString());
  } catch {
    const wasmByteCode = new Uint8Array(readFileSync(WASM_PATH));
    console.log(`Storing mock-dex-pool code (${wasmByteCode.length} bytes)...`);
    const storeRes = await admin.broadcastTxSync({
      msgs: [new MsgStoreCode({ sender: admin.address, wasmByteCode })],
    });
    if (storeRes.txResponse.code !== 0) throw new Error(`Store failed: ${storeRes.txResponse.rawLog}`);
    const codeIdAttr = storeRes.txResponse.events
      .find((e) => e.type === "store_code")
      ?.attributes.find((a) => a.key === "code_id");
    if (!codeIdAttr) throw new Error("code_id not found in store_code tx events");
    codeId = BigInt(codeIdAttr.value);
    writeFileSync(codeIdCachePath, JSON.stringify({ codeId: codeId.toString() }, null, 2));
    console.log(`Code ID: ${codeId} | gasUsed: ${storeRes.txResponse.gasUsed}`);
  }

  const instRes = await admin.broadcastTxSync({
    msgs: [
      new MsgInstantiateContract({
        sender: admin.address,
        codeId,
        label: `mock-dex-pool-${label}`,
        msg: {
          reserves: [
            [denomA, amountA],
            [denomB, amountB],
          ],
        },
        funds: [],
      }),
    ],
  });
  if (instRes.txResponse.code !== 0) throw new Error(`Instantiate failed: ${instRes.txResponse.rawLog}`);
  const addrAttr = instRes.txResponse.events
    .find((e) => e.type === "instantiate")
    ?.attributes.find((a) => a.key === "_contract_address");
  if (!addrAttr) throw new Error("contract address not found in instantiate tx events");
  const contractAddress = addrAttr.value;
  console.log(`mock-dex-pool (${label}) address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(deploymentPath, JSON.stringify({ contractAddress }, null, 2));
  console.log("Saved to", deploymentPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
