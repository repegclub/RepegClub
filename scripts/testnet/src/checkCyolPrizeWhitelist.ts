import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation against the live chain (not just unit tests): does the
// redeployed raffle code actually reject a CW20 or non-whitelisted native
// prize on a paid raffle, still accept a whitelisted native prize, and still
// allow anything at all on a free (ticket_price = 0) raffle? Uses whichever
// factory deployment JSON is passed as argv[2] (defaults to frontenddev3,
// the redeploy carrying the prize whitelist + funds-rejection fix).
const [, , label = "frontenddev3"] = process.argv;

// A real, syntactically valid bech32 address (the platform's own founder-fee
// wallet) standing in for "some CW20 contract" - the whitelist check fires
// right after addr_validate, before anything checks the address actually
// holds CW20 code, so any valid-format address works for this test.
const FAKE_CW20_ADDRESS = "terra15dv0f2rykyp6gyvuhawk8qgfd7ypm4lgkm4z39";

const baseFields = {
  raffle_type: "single_winner" as const,
  ticket_denom: "utestusdc", // paid raffles must use the platform's USDC (2026-07-21), this script predates that; fine for the free case too (any denom is allowed there)
  allowed_entrants: null,
  min_players: 2,
  // >= UNSAFE_MAX_PLAYERS_THRESHOLD (20) in the factory's cooldown check
  // (2026-07-22) - keeps the paid-raffle case "safe-shaped" so re-running
  // this script never collides with the factory's anti-spam cooldown for
  // repeat unsafe-shaped raffles from the same admin wallet. Unrelated to
  // what this script tests (prize whitelist).
  max_players: 25,
  round_timeout_seconds: 3600,
  draw_delay_blocks: 2,
  draw_window_blocks: 60,
  unclaimed_deadline_days: 90,
  max_raffle_age_seconds: 604800, // required field added 2026-07-21, this script predates it
  podium_shares_bps: [] as number[],
};

async function tryCreateRaffle(
  factoryAddress: string,
  admin: ReturnType<typeof loadWallet>,
  ticketPrice: string,
  prizeNativeDenom: string | null,
  prizeCw20Address: string | null
) {
  return admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            ...baseFields,
            ticket_price: ticketPrice,
            prize_native_denom: prizeNativeDenom,
            prize_cw20_address: prizeCw20Address,
          },
        },
        funds: [],
      }),
    ],
  });
}

async function expectRejected(label: string, run: () => Promise<unknown>) {
  console.log(`\n${label} - expecting rejection...`);
  try {
    await run();
    throw new Error(`Expected ${label} to fail, but it succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("PrizeAssetNotAllowlisted") && !message.includes("prize")) {
      throw new Error(`Failed, but not with the expected error: ${message}`);
    }
    console.log(`OK: rejected (${message.split("\n")[0].slice(0, 120)})`);
  }
}

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");

  await expectRejected("Paid raffle, CW20 prize", () =>
    tryCreateRaffle(factoryAddress, admin, "1000000", null, FAKE_CW20_ADDRESS)
  );

  await expectRejected("Paid raffle, non-whitelisted native prize (unft)", () =>
    tryCreateRaffle(factoryAddress, admin, "1000000", "unft", null)
  );

  console.log("\nPaid raffle, whitelisted native prize (uluna) - expecting success...");
  const paidOk = await tryCreateRaffle(factoryAddress, admin, "1000000", "uluna", null);
  if (paidOk.txResponse.code !== 0) {
    throw new Error(`Expected success: ${paidOk.txResponse.rawLog}`);
  }
  console.log(`OK: accepted | gasUsed: ${paidOk.txResponse.gasUsed}`);

  console.log("\nFree raffle (ticket_price=0), CW20 prize - expecting success (no whitelist applies)...");
  const freeOk = await tryCreateRaffle(
    factoryAddress,
    admin,
    "0",
    null,
    FAKE_CW20_ADDRESS
  );
  if (freeOk.txResponse.code !== 0) {
    throw new Error(`Expected success: ${freeOk.txResponse.rawLog}`);
  }
  console.log(`OK: accepted | gasUsed: ${freeOk.txResponse.gasUsed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
