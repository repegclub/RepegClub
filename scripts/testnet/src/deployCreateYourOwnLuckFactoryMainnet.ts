import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { commitPusherAddress as getCommitPusherAddress, loadWallet } from "./configMainnet";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

// Real mainnet deploy - see deployCreateYourOwnLuckFactory.ts (testnet) for
// the tested original this mirrors. Only real difference: imports from
// ./configMainnet instead of ./config, so a real mainnet mnemonic can never
// end up pointed at rebel-2 testnet or vice versa.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAFFLE_WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/create-your-own-luck/artifacts/create_your_own_luck.wasm"
);
const FACTORY_WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/create-your-own-luck-factory/artifacts/create_your_own_luck_factory.wasm"
);

// node src/deployCreateYourOwnLuckFactoryMainnet.ts <label>
const [, , label] = process.argv;
if (!label) {
  console.error("Usage: tsx src/deployCreateYourOwnLuckFactoryMainnet.ts <label>");
  process.exit(1);
}
// A label containing path separators/`..` (e.g. "x/../../package") could
// make path.resolve below leave scripts/testnet and overwrite an arbitrary
// .json file elsewhere on disk (CodeRabbit finding, 2026-09-20 review,
// eighth round).
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
  console.error("label may contain only letters, digits, dots, underscores, and hyphens.");
  process.exit(1);
}
const FACTORY_INSTANTIATE_LABEL = `create-your-own-luck-factory-${label}`;
// Terra Classic's wasmd (v0.61.8) rejects an instantiate label over its
// configured MaxLabelSize (128 UTF-8 bytes by default) - checked on the
// complete prefixed label, not just the user-supplied suffix, before
// storeCode spends gas (CodeRabbit finding, 2026-09-20 review, tenth round).
if (new TextEncoder().encode(FACTORY_INSTANTIATE_LABEL).length > 128) {
  console.error(`Instantiate label "${FACTORY_INSTANTIATE_LABEL}" is over wasmd's 128-byte MaxLabelSize.`);
  process.exit(1);
}
const deploymentPath = path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`);

async function main() {
  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin (creator) address:", admin.address);

  const commitPusherAddress = getCommitPusherAddress();
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
        label: FACTORY_INSTANTIATE_LABEL,
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
