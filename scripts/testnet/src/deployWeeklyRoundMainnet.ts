import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  ADMIN_FEE_ADDRESS,
  REDEMPTION_DENOM,
  TICKET_DENOM,
  TREASURY_ADDRESS,
  commitPusherAddress as getCommitPusherAddress,
  loadWallet,
} from "./configMainnet";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

// Real mainnet deploy - see deployWeeklyRound.ts (testnet) for the tested
// original this mirrors. Differences: imports from ./configMainnet, real
// ticket_denom/redemption_denom (USDC/USTC instead of uluna/uluna), and a
// distinct output filename - weekly-round is a platform singleton with a
// FIXED name on testnet (deployment-weekly-round.json, no label), which
// keeperTargets.ts's discoverTargets() matches by that exact string. Reusing
// that same name here would silently overwrite testnet's own deployment file
// in this same directory - deliberately named differently instead (decided
// with the user 2026-09-10, see the Obsidian mainnet deploy plan).
const DEPLOYMENT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../deployment-weekly-round-mainnet.json"
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/weekly-round/artifacts/weekly_round.wasm"
);

// node src/deployWeeklyRoundMainnet.ts <label> [maxPlayers] [minPlayers] [roundDurationDays]
// label is required here (unlike the testnet script) - there's no sane
// default for a real production label, and DEPLOYMENT_PATH is fixed
// regardless of it (kept as an argument only for the instantiate tx's own
// on-chain label, for consistency with the other 2 mainnet scripts).
const [, , label, maxPlayersArg, minPlayersArg, durationArg] = process.argv;
if (!label) {
  console.error("Usage: tsx src/deployWeeklyRoundMainnet.ts <label> [maxPlayers] [minPlayers] [roundDurationDays]");
  process.exit(1);
}
const maxPlayers = maxPlayersArg ? Number(maxPlayersArg) : 10;
const minPlayers = minPlayersArg ? Number(minPlayersArg) : 2;
const roundDurationDays = durationArg ? Number(durationArg) : 7;

// Without this, a bad arg (typo, missing quotes) only surfaces after
// MsgStoreCode already spent real mainnet gas - instantiate then fails and
// the stored code is wasted (CodeRabbit finding, 2026-09-19 review). Bounds
// mirror the contract's own limits (see wheel-manager/weekly-round
// instantiate validation).
if (!Number.isSafeInteger(minPlayers) || minPlayers < 2) {
  console.error(`minPlayers must be an integer >= 2, got "${minPlayersArg}".`);
  process.exit(1);
}
if (!Number.isSafeInteger(maxPlayers) || maxPlayers < minPlayers || maxPlayers > 100) {
  console.error(`maxPlayers must be an integer between minPlayers (${minPlayers}) and 100, got "${maxPlayersArg}".`);
  process.exit(1);
}
if (!Number.isSafeInteger(roundDurationDays) || roundDurationDays < 1 || roundDurationDays > 365) {
  console.error(`roundDurationDays must be an integer between 1 and 365, got "${durationArg}".`);
  process.exit(1);
}

async function main() {
  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin address:", admin.address);

  const commitPusherAddress = getCommitPusherAddress();
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
          ticket_denom: TICKET_DENOM,
          redemption_denom: REDEMPTION_DENOM,
          min_players: minPlayers,
          max_players: maxPlayers,
          round_duration_days: roundDurationDays,
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
