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

// node src/deployWeeklyRound.ts [label] [maxPlayers] [minPlayers] [roundDurationDays]
// All optional, same convention as deployWheelManager.ts - lets a testnet/dev
// deploy reach max_players with a couple of test wallets instead of waiting
// out the real 7-day round_duration_days default.
const [, , labelArg, maxPlayersArg, minPlayersArg, durationArg] = process.argv;
const label = labelArg ?? "weekly-round";
const maxPlayers = maxPlayersArg ? Number(maxPlayersArg) : 10;
const minPlayers = minPlayersArg ? Number(minPlayersArg) : 2;
const roundDurationDays = durationArg ? Number(durationArg) : 7;
// Fixed filename regardless of label - weekly-round is a platform singleton
// (unlike wheel-manager's multiple tiers or CYOL's many raffles), and
// keeperTargets.ts's discoverTargets() looks for this exact name.
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
        label: `weekly-round-${label}`,
        msg: {
          base_ticket_price: "10000000",
          price_increment_per_day: "1000000",
          ticket_denom: "uluna",
          redemption_denom: "uluna",
          min_players: minPlayers,
          max_players: maxPlayers,
          round_duration_days: roundDurationDays,
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
