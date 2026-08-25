import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { USDC_DENOM, USTC_DENOM, loadWallet } from "./configMainnetTest";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/wheel-manager/artifacts/wheel_manager.wasm"
);
const weeklyStubDeploymentPath = path.resolve(
  __dirname,
  "../deployment-weekly-stub-mainnet-test.json"
);
const DEPLOYMENT_PATH = path.resolve(__dirname, "../deployment-wheelmanager-mainnet-test.json");

// Cheap, disposable burn-tax verification deploy (see docs/terra-classic-chain-notes.md
// and the 2026-07-13 conversation) - real USDC/USTC denoms, tiny ticket price.
// min_players=2 (unique wallets, not ticket count) with max_players=4 so the
// per-wallet cap (max(1, max_players/2) = 2) doesn't force a 3rd wallet.
const TICKET_PRICE = "50000"; // 0.05 USDC
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const ROUND_TIMEOUT_SECONDS = 60; // contract minimum (see MIN_ROUND_TIMEOUT_SECONDS), was 30 before the 2026-08-24 instantiate bounds fix
const MAX_ROUND_AGE_SECONDS = 172_800; // 48h default, irrelevant for this quick test

async function main() {
  const { contractAddress: weeklyRoundAddress } = JSON.parse(
    readFileSync(weeklyStubDeploymentPath, "utf8")
  );
  console.log("Weekly-round-stub address:", weeklyRoundAddress);

  const admin = loadWallet("MAINNET_TEST_ADMIN_MNEMONIC");
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

  // Disposable test deploy - admin's own wallet doubles as treasury and
  // admin-fee recipient (confirmed with the user 2026-07-13), so nothing
  // leaks anywhere else.
  const instRes = await admin.broadcastTxSync({
    msgs: [
      new MsgInstantiateContract({
        sender: admin.address,
        codeId,
        label: "wheel-manager (MAINNET TAX TEST - disposable)",
        msg: {
          ticket_price: TICKET_PRICE,
          ticket_denom: USDC_DENOM,
          redemption_denom: USTC_DENOM,
          min_players: MIN_PLAYERS,
          max_players: MAX_PLAYERS,
          round_timeout_seconds: ROUND_TIMEOUT_SECONDS,
          draw_delay_blocks: 2,
          draw_window_blocks: 10,
          unclaimed_deadline_days: 1, // contract minimum (see MIN_UNCLAIMED_DEADLINE_DAYS), was 0 before the 2026-08-24 instantiate bounds fix
          max_round_age_seconds: MAX_ROUND_AGE_SECONDS,
          treasury_address: admin.address,
          admin_fee_address: admin.address,
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
  console.log(`Wheel Manager address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(
    DEPLOYMENT_PATH,
    JSON.stringify(
      { codeId: codeId.toString(), contractAddress, ticketPrice: TICKET_PRICE },
      null,
      2
    )
  );
  console.log("Saved to", DEPLOYMENT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
