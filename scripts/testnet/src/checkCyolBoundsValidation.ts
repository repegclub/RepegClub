import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation against the live chain (not just unit tests): does the
// redeployed raffle code actually reject round_timeout_seconds out of range
// via CreateRaffle -> SubMsg -> instantiate, and still accept a normal
// raffle? (round-10 audit fix: the header used to also claim
// draw_delay_blocks/draw_window_blocks coverage - tryCreateRaffle only ever
// varies round_timeout_seconds, those two bounds aren't exercised here at
// all). Uses whichever factory deployment JSON is passed as argv[2]
// (defaults to frontenddev2, the redeploy carrying the new bounds fix).
const [, , label = "frontenddev2"] = process.argv;

const baseFields = {
  raffle_type: "single_winner" as const,
  ticket_price: "1000000", // $1 - meets the paid-raffle minimum (2026-07-21)
  ticket_denom: "uluna", // paid raffles must use the platform's USDC, which is "uluna" on this testnet (see checkBatchBuyTicket.ts) - "utestusdc" doesn't exist and the factory would reject it
  allowed_entrants: null,
  min_players: 2,
  // >= UNSAFE_MAX_PLAYERS_THRESHOLD (20) in the factory's cooldown check
  // (2026-07-22) - keeps this "safe-shaped" so re-running this script never
  // collides with the factory's anti-spam cooldown for repeat unsafe-shaped
  // raffles from the same admin wallet. Unrelated to what this script tests
  // (round_timeout_seconds bounds).
  max_players: 25,
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

  console.log("\n1. round_timeout_seconds = 0 (below MIN=86400) - expecting failure...");
  // The contract error surfaces during broadcastTxSync's internal gas
  // simulation (a thrown RPC error), not as a broadcast tx response with a
  // nonzero code - the message never actually reaches the chain's mempool.
  // succeeded, checked after the try/catch (round-12 audit fix, Opus): this
  // used to throw its own "but it succeeded" error from inside the same try
  // its catch re-wraps as "Failed, but not with the expected error: Expected
  // ... but it succeeded" - the wrong diagnosis (looks like a wrong-error
  // case, when it's actually a no-error-at-all case) for whoever debugs a
  // real bounds regression. Same fix already applied to
  // checkCyolPrizeWhitelist.ts (round 11) and checkCyolCreatorCooldown.ts
  // (round 12).
  let succeeded = false;
  try {
    await tryCreateRaffle(factoryAddress, admin, 0);
    succeeded = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("round_timeout_seconds must be between")) {
      throw new Error(`Failed, but not with the expected error: ${message}`);
    }
    console.log("OK: rejected with the expected InvalidRoundTimeoutSeconds message.");
  }
  if (succeeded) {
    throw new Error("Expected create_raffle to fail with round_timeout_seconds=0, but it succeeded");
  }

  // 86_400 (24h) is the contract's MIN as of the round-10 audit fix, raised
  // from the original 1h floor - that old floor equaled
  // ANTI_SNIPE_EXTENSION_SECONDS exactly, so a raffle instantiated with it
  // started life already inside the anti-snipe window and every purchase
  // extended the deadline (see MIN_ROUND_TIMEOUT_SECONDS's own doc comment
  // in contract.rs). This boundary case is exactly the value that used to
  // be silently degenerate.
  console.log("\n2. round_timeout_seconds = 86400 (in range, at the new MIN) - expecting success...");
  const accepted = await tryCreateRaffle(factoryAddress, admin, 86_400);
  if (accepted.txResponse.code !== 0) {
    throw new Error(`Expected create_raffle to succeed with round_timeout_seconds=86400: ${accepted.txResponse.rawLog}`);
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
