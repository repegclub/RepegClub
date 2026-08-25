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

// node src/deployWheelManager.ts <label> <maxPlayers> <minPlayers> [roundTimeoutSeconds] [maxRoundAgeSeconds] [ticketPriceUluna] [drawWindowBlocks] [unclaimedDeadlineDays]
const [
  ,
  ,
  label,
  maxPlayersArg,
  minPlayersArg,
  timeoutArg,
  maxAgeArg,
  ticketPriceArg,
  drawWindowArg,
  unclaimedDeadlineArg,
] = process.argv;
if (!label || !maxPlayersArg || !minPlayersArg) {
  console.error(
    "Usage: tsx src/deployWheelManager.ts <label> <maxPlayers> <minPlayers> [roundTimeoutSeconds] [maxRoundAgeSeconds] [ticketPriceUluna] [drawWindowBlocks] [unclaimedDeadlineDays]"
  );
  process.exit(1);
}
const maxPlayers = Number(maxPlayersArg);
const minPlayers = Number(minPlayersArg);
const roundTimeoutSeconds = timeoutArg ? Number(timeoutArg) : 3600;
// Different tiers (see multi-tier UI work) need different ticket prices -
// defaults to 1 LUNC to match every deploy before this option existed.
const ticketPrice = ticketPriceArg ?? "1000000";
// Hard ceiling on a round's Open lifetime (see max_round_age_seconds in the
// contract) - defaults to 48h, the low end of the original 48-72h design
// range. Real deploys should keep this default; testnet/dev deploys can pass
// something shorter to actually exercise ExpireRound/ReclaimTicket faster,
// down to the contract's own minimum of 1 day (MIN_MAX_ROUND_AGE_SECONDS,
// 2026-08-24 instantiate bounds fix - 0 or a few minutes is no longer
// accepted).
const maxRoundAgeSeconds = maxAgeArg ? Number(maxAgeArg) : 172_800;
// Width of the anti-grinding draw window (see draw_window_blocks in the
// contract) - defaults to 60 blocks (~5-6 min at Terra Classic's ~5.6s block
// time), sized to cover a keeper crash-restart (systemd: <=5s + up to 15s to
// the next poll) and a typical VM reboot with comfortable margin, decided
// 2026-07-15. Testnet/dev deploys can pass something much shorter to
// exercise the rearm path without waiting minutes.
const drawWindowBlocks = drawWindowArg ? Number(drawWindowArg) : 60;
// Days before an unredeemed prize/pot becomes sweepable (see
// unclaimed_deadline_days in the contract) - defaults to 90, matching the
// design doc and the contract's own test defaults. Testnet/dev deploys can
// pass 1 (the contract's own minimum, MIN_UNCLAIMED_DEADLINE_DAYS - 0 is no
// longer accepted since the 2026-08-24 instantiate bounds fix) to exercise
// SweepExpiredPrize after the shortest possible wait.
const unclaimedDeadlineDays = unclaimedDeadlineArg ? Number(unclaimedDeadlineArg) : 90;
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
          ticket_price: ticketPrice,
          ticket_denom: "uluna",
          redemption_denom: "uluna",
          min_players: minPlayers,
          max_players: maxPlayers,
          round_timeout_seconds: roundTimeoutSeconds,
          draw_delay_blocks: 2,
          draw_window_blocks: drawWindowBlocks,
          unclaimed_deadline_days: unclaimedDeadlineDays,
          max_round_age_seconds: maxRoundAgeSeconds,
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
    JSON.stringify(
      { codeId: codeId.toString(), contractAddress, maxPlayers, minPlayers, ticketPrice },
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
