import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation against the live chain (not just unit tests): does the
// redeployed raffle code actually reject round_timeout_seconds/
// draw_delay_blocks/draw_window_blocks out of range via CreateRaffle -> SubMsg
// -> instantiate, and still accept a normal raffle? Uses whichever factory
// deployment JSON is passed as argv[2] (defaults to frontenddev2, the
// redeploy carrying the new bounds fix).
const [, , label = "frontenddev2"] = process.argv;

const baseFields = {
  raffle_type: "single_winner" as const,
  ticket_price: "1000000",
  ticket_denom: "uluna",
  allowed_entrants: null,
  min_players: 2,
  max_players: 10,
  draw_delay_blocks: 2,
  draw_window_blocks: 60,
  unclaimed_deadline_days: 90,
  prize_native_denom: "uluna",
  prize_cw20_address: null,
  podium_shares_bps: [] as number[],
};

async function tryCreateRaffle(
  factoryAddress: string,
  admin: ReturnType<typeof loadWallet>,
  roundTimeoutSeconds: number
) {
  return admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            ...baseFields,
            round_timeout_seconds: roundTimeoutSeconds,
          },
        },
        funds: [],
      }),
    ],
  });
}

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");

  console.log("\n1. round_timeout_seconds = 0 (below MIN=60) - expecting failure...");
  // The contract error surfaces during broadcastTxSync's internal gas
  // simulation (a thrown RPC error), not as a broadcast tx response with a
  // nonzero code - the message never actually reaches the chain's mempool.
  try {
    await tryCreateRaffle(factoryAddress, admin, 0);
    throw new Error("Expected create_raffle to fail with round_timeout_seconds=0, but it succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("round_timeout_seconds must be between")) {
      throw new Error(`Failed, but not with the expected error: ${message}`);
    }
    console.log("OK: rejected with the expected InvalidRoundTimeoutSeconds message.");
  }

  console.log("\n2. round_timeout_seconds = 3600 (in range) - expecting success...");
  const accepted = await tryCreateRaffle(factoryAddress, admin, 3600);
  if (accepted.txResponse.code !== 0) {
    throw new Error(`Expected create_raffle to succeed with round_timeout_seconds=3600: ${accepted.txResponse.rawLog}`);
  }
  const addr = accepted.txResponse.events
    .find((e) => e.type === "instantiate")
    ?.attributes.find((a) => a.key === "_contract_address")?.value;
  console.log(`OK: accepted, new raffle at ${addr} | gasUsed: ${accepted.txResponse.gasUsed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
