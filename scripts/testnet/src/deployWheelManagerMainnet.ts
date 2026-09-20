import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { fromBech32 } from "@cosmjs/encoding";

import { ADMIN_FEE_ADDRESS, REDEMPTION_DENOM, TICKET_DENOM, TREASURY_ADDRESS, loadWallet } from "./configMainnet";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

// Real mainnet deploy - see deployWheelManager.ts (testnet) for the tested
// original this mirrors. Differences: imports from ./configMainnet, real
// ticket_denom/redemption_denom (USDC/USTC instead of uluna/uluna), and
// reads weekly-round's mainnet deployment file by default (see
// deployWeeklyRoundMainnet.ts for why that file has a distinct name).
// Production defaults (round_timeout_seconds/max_round_age_seconds/
// ticket_price/max_reveal_age_seconds/unclaimed_deadline_days) are the same
// ones already decided and already used by every real deploy of this
// contract - see the Obsidian mainnet deploy plan, section 1.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/wheel-manager/artifacts/wheel_manager.wasm"
);

// node src/deployWheelManagerMainnet.ts <label> <maxPlayers> <minPlayers> [roundTimeoutSeconds] [maxRoundAgeSeconds] [ticketPrice] [maxRevealAgeSeconds] [unclaimedDeadlineDays] [weeklyRoundDeploymentFile]
const [
  ,
  ,
  label,
  maxPlayersArg,
  minPlayersArg,
  timeoutArg,
  maxAgeArg,
  ticketPriceArg,
  maxRevealAgeArg,
  unclaimedDeadlineArg,
  weeklyRoundDeploymentFileArg,
] = process.argv;
if (!label || !maxPlayersArg || !minPlayersArg) {
  console.error(
    "Usage: tsx src/deployWheelManagerMainnet.ts <label> <maxPlayers> <minPlayers> [roundTimeoutSeconds] [maxRoundAgeSeconds] [ticketPrice] [maxRevealAgeSeconds] [unclaimedDeadlineDays] [weeklyRoundDeploymentFile]"
  );
  process.exit(1);
}
const maxPlayers = Number(maxPlayersArg);
const minPlayers = Number(minPlayersArg);
const roundTimeoutSeconds = timeoutArg ? Number(timeoutArg) : 3600;
const ticketPrice = ticketPriceArg ?? "1000000";
const maxRoundAgeSeconds = maxAgeArg ? Number(maxAgeArg) : 172_800;
const maxRevealAgeSeconds = maxRevealAgeArg ? Number(maxRevealAgeArg) : 3600;
const unclaimedDeadlineDays = unclaimedDeadlineArg ? Number(unclaimedDeadlineArg) : 90;
const deploymentPath = path.resolve(__dirname, `../deployment-wheelmanager-${label}.json`);
// Defaults to weekly-round's real mainnet deployment file (see
// deployWeeklyRoundMainnet.ts) - run that script first.
const weeklyRoundDeploymentPath = path.resolve(
  __dirname,
  `../${weeklyRoundDeploymentFileArg ?? "deployment-weekly-round-mainnet.json"}`
);

async function main() {
  const { contractAddress: weeklyRoundAddress } = JSON.parse(
    readFileSync(weeklyRoundDeploymentPath, "utf8")
  );
  // Without this, a missing/malformed contractAddress in the deployment
  // file only surfaces at instantiate() - by then MsgStoreCode already
  // spent real gas (CodeRabbit finding, 2026-09-19 review, fourth round).
  let weeklyRoundPrefix: string | undefined;
  try {
    weeklyRoundPrefix = typeof weeklyRoundAddress === "string" ? fromBech32(weeklyRoundAddress).prefix : undefined;
  } catch {
    weeklyRoundPrefix = undefined;
  }
  if (weeklyRoundPrefix !== "terra") {
    throw new Error(
      `"${weeklyRoundDeploymentPath}" has no valid Weekly Round contractAddress (got ${JSON.stringify(weeklyRoundAddress)}).`
    );
  }
  console.log("Weekly Round address:", weeklyRoundAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin address:", admin.address);

  const commitPusherAddress = loadWallet("COMMIT_PUSHER_MNEMONIC").address;
  console.log("commit_pusher address:", commitPusherAddress);

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
          ticket_denom: TICKET_DENOM,
          redemption_denom: REDEMPTION_DENOM,
          min_players: minPlayers,
          max_players: maxPlayers,
          round_timeout_seconds: roundTimeoutSeconds,
          unclaimed_deadline_days: unclaimedDeadlineDays,
          max_round_age_seconds: maxRoundAgeSeconds,
          max_reveal_age_seconds: maxRevealAgeSeconds,
          treasury_address: TREASURY_ADDRESS,
          admin_fee_address: ADMIN_FEE_ADDRESS,
          weekly_round_address: weeklyRoundAddress,
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
