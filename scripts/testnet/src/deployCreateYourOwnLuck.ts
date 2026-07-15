import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadWallet } from "./config";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../contracts/create-your-own-luck/artifacts/create_your_own_luck.wasm"
);

// node src/deployCreateYourOwnLuck.ts <label> <raffleType> <minPlayers> <maxPlayers> <ticketPrice> [podiumSharesBps]
// podiumSharesBps: optional, comma-separated basis points summing to 10000,
// e.g. "5000,3000,2000" for a 50/30/20 podium of 3. Only valid when
// raffleType is Podium - defaults to 50/30/20 if omitted for a Podium raffle.
const [, , label, raffleType, minPlayersArg, maxPlayersArg, ticketPriceArg, podiumSharesArg] = process.argv;
if (!label || !raffleType || !minPlayersArg || !maxPlayersArg || !ticketPriceArg) {
  console.error(
    "Usage: tsx src/deployCreateYourOwnLuck.ts <label> <SingleWinner|Podium|Airdrop> <minPlayers> <maxPlayers> <ticketPrice> [podiumSharesBps]"
  );
  process.exit(1);
}
if (!["SingleWinner", "Podium", "Airdrop"].includes(raffleType)) {
  throw new Error(`Invalid raffle type: ${raffleType} (expected SingleWinner, Podium, or Airdrop)`);
}
if (podiumSharesArg && raffleType !== "Podium") {
  throw new Error("podiumSharesBps is only valid for Podium raffles");
}
const podiumSharesBps = podiumSharesArg
  ? podiumSharesArg.split(",").map(Number)
  : raffleType === "Podium"
    ? [5000, 3000, 2000]
    : [];
if (raffleType === "Podium") {
  const sum = podiumSharesBps.reduce((total, share) => total + share, 0);
  const allValid = podiumSharesBps.every((share) => Number.isInteger(share) && share > 0);
  if (podiumSharesBps.length === 0 || podiumSharesBps.length > 10 || !allValid || sum !== 10_000) {
    throw new Error("podiumSharesBps must be 1-10 positive integers summing to exactly 10000");
  }
}
const deploymentPath = path.resolve(__dirname, `../deployment-cyol-${label}.json`);

async function main() {
  const admin = loadWallet("ADMIN_MNEMONIC");
  console.log("Admin (creator) address:", admin.address);

  const wasmByteCode = new Uint8Array(readFileSync(WASM_PATH));
  console.log(`Storing create-your-own-luck code (${wasmByteCode.length} bytes)...`);
  const storeRes = await admin.broadcastTxSync({
    msgs: [new MsgStoreCode({ sender: admin.address, wasmByteCode })],
  });
  if (storeRes.txResponse.code !== 0) throw new Error(`Store failed: ${storeRes.txResponse.rawLog}`);
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
        label: `create-your-own-luck-${label}`,
        msg: {
          raffle_type: raffleType,
          ticket_price: ticketPriceArg,
          ticket_denom: "uluna",
          allowed_entrants: null,
          min_players: Number(minPlayersArg),
          max_players: Number(maxPlayersArg),
          round_timeout_seconds: 3600,
          draw_delay_blocks: 2,
          draw_window_blocks: 10,
          unclaimed_deadline_days: 90,
          prize_native_denom: "uluna",
          prize_cw20_address: null,
          podium_shares_bps: podiumSharesBps,
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
  console.log(`Create Your Own Luck (${label}) address: ${contractAddress} | gasUsed: ${instRes.txResponse.gasUsed}`);

  writeFileSync(deploymentPath, JSON.stringify({ codeId: codeId.toString(), contractAddress }, null, 2));
  console.log("Saved to", deploymentPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
