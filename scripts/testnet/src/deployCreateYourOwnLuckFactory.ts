import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadWallet } from "./config";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAFFLE_WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/create-your-own-luck/artifacts/create_your_own_luck.wasm"
);
const FACTORY_WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/create-your-own-luck-factory/artifacts/create_your_own_luck_factory.wasm"
);

// node src/deployCreateYourOwnLuckFactory.ts <label>
//
// Stores create-your-own-luck's wasm fresh (rather than reusing a code_id
// from some earlier test deployment) so the factory always points at
// whatever raffle code is actually on disk right now, then stores +
// instantiates the factory itself pointing at that code_id.
const [, , label] = process.argv;
if (!label) {
  console.error("Usage: tsx src/deployCreateYourOwnLuckFactory.ts <label>");
  process.exit(1);
}
const deploymentPath = path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`);

async function main() {
  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin (creator) address:", admin.address);

  // See COMMIT_PUSHER's own doc comment (state.rs) - a role separate from
  // ADMIN, gating only PushCommits. Only its address is needed here (never
  // signs anything in this script).
  const commitPusherAddress = loadWallet("COMMIT_PUSHER_MNEMONIC").address;
  console.log("commit_pusher address:", commitPusherAddress);

  const raffleWasmByteCode = new Uint8Array(readFileSync(RAFFLE_WASM_PATH));
  console.log(`Storing create-your-own-luck code (${raffleWasmByteCode.length} bytes)...`);
  const raffleStoreRes = await admin.broadcastTxSync({
    msgs: [new MsgStoreCode({ sender: admin.address, wasmByteCode: raffleWasmByteCode })],
  });
  if (raffleStoreRes.txResponse.code !== 0) {
    throw new Error(`Raffle store failed: ${raffleStoreRes.txResponse.rawLog}`);
  }
  const raffleCodeIdAttr = raffleStoreRes.txResponse.events
    .find((e) => e.type === "store_code")
    ?.attributes.find((a) => a.key === "code_id");
  if (!raffleCodeIdAttr) throw new Error("code_id not found in raffle store_code tx events");
  const raffleCodeId = BigInt(raffleCodeIdAttr.value);
  console.log(`Raffle code ID: ${raffleCodeId} | gasUsed: ${raffleStoreRes.txResponse.gasUsed}`);

  const factoryWasmByteCode = new Uint8Array(readFileSync(FACTORY_WASM_PATH));
  console.log(`Storing create-your-own-luck-factory code (${factoryWasmByteCode.length} bytes)...`);
  const factoryStoreRes = await admin.broadcastTxSync({
    msgs: [new MsgStoreCode({ sender: admin.address, wasmByteCode: factoryWasmByteCode })],
  });
  if (factoryStoreRes.txResponse.code !== 0) {
    throw new Error(`Factory store failed: ${factoryStoreRes.txResponse.rawLog}`);
  }
  const factoryCodeIdAttr = factoryStoreRes.txResponse.events
    .find((e) => e.type === "store_code")
    ?.attributes.find((a) => a.key === "code_id");
  if (!factoryCodeIdAttr) throw new Error("code_id not found in factory store_code tx events");
  const factoryCodeId = BigInt(factoryCodeIdAttr.value);
  console.log(`Factory code ID: ${factoryCodeId} | gasUsed: ${factoryStoreRes.txResponse.gasUsed}`);

  const instRes = await admin.broadcastTxSync({
    msgs: [
      new MsgInstantiateContract({
        sender: admin.address,
        codeId: factoryCodeId,
        label: `create-your-own-luck-factory-${label}`,
        msg: { raffle_code_id: Number(raffleCodeId), commit_pusher: commitPusherAddress },
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
  console.log(`Create Your Own Luck Factory (${label}) address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(
    deploymentPath,
    JSON.stringify(
      {
        raffleCodeId: raffleCodeId.toString(),
        factoryCodeId: factoryCodeId.toString(),
        contractAddress,
      },
      null,
      2
    )
  );
  console.log("Saved to", deploymentPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
