import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation against the live chain: does the factory's growing
// cooldown for repeated "unsafe-shaped" raffles (paid, non-Airdrop,
// max_players below UNSAFE_MAX_PLAYERS_THRESHOLD=20) actually reject a
// second one from the same wallet - and, crucially (this is what a
// CodeRabbit review caught as broken in an earlier version), does a
// safe-shaped raffle in between leave that cooldown untouched instead of
// wiping it for free?
const [, , label = "frontenddev5"] = process.argv;

const unsafeFields = {
  raffle_type: "single_winner" as const,
  ticket_price: "1000000",
  ticket_denom: "utestusdc",
  allowed_entrants: null,
  min_players: 2,
  max_players: 10, // < 20 -> unsafe shape
  round_timeout_seconds: 3600,
  draw_delay_blocks: 2,
  draw_window_blocks: 60,
  unclaimed_deadline_days: 90,
  max_raffle_age_seconds: 604800,
  prize_native_denom: "uluna",
  prize_cw20_address: null,
  podium_shares_bps: [] as number[],
};

const safeFields = { ...unsafeFields, max_players: 25 }; // >= 20 -> safe shape

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  // Fresh, dedicated wallet so this doesn't collide with whatever cooldown
  // state ADMIN_MNEMONIC already has from other check scripts.
  const wallet = loadWallet("PLAYER1_MNEMONIC");
  console.log("Wallet:", wallet.address);

  console.log("\n1. First unsafe-shaped raffle - expecting success...");
  const first = await wallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: wallet.address,
        contract: factoryAddress,
        msg: { create_raffle: unsafeFields },
        funds: [],
      }),
    ],
  });
  if (first.txResponse.code !== 0) throw new Error(`Expected success: ${first.txResponse.rawLog}`);
  console.log(`OK: accepted | gasUsed: ${first.txResponse.gasUsed}`);

  const cooldownAfterFirst = await queryContract<{ unsafe_streak: number; next_unsafe_allowed_at: number | null }>(
    RPC,
    { address: factoryAddress, query: { get_creator_cooldown: { creator: wallet.address } } }
  );
  console.log("Cooldown after 1st unsafe raffle:", cooldownAfterFirst);
  if (cooldownAfterFirst.unsafe_streak !== 1 || cooldownAfterFirst.next_unsafe_allowed_at === null) {
    throw new Error("Expected unsafe_streak=1 with a cooldown timestamp set");
  }

  console.log("\n2. Second unsafe-shaped raffle right away - expecting rejection (cooldown)...");
  try {
    const second = await wallet.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: wallet.address,
          contract: factoryAddress,
          msg: { create_raffle: unsafeFields },
          funds: [],
        }),
      ],
    });
    if (second.txResponse.code === 0) {
      throw new Error("Expected the second unsafe-shaped raffle to fail, but it succeeded");
    }
    if (!second.txResponse.rawLog.includes("cooldown")) {
      throw new Error(`Failed, but not with the expected error: ${second.txResponse.rawLog}`);
    }
    console.log("OK: rejected with a cooldown message.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("cooldown")) {
      throw new Error(`Failed, but not with the expected error: ${message}`);
    }
    console.log("OK: rejected with a cooldown message.");
  }

  console.log(
    "\n3. A safe-shaped raffle right away - expecting success, and the active cooldown must NOT be touched..."
  );
  const safe = await wallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: wallet.address,
        contract: factoryAddress,
        msg: { create_raffle: safeFields },
        funds: [],
      }),
    ],
  });
  if (safe.txResponse.code !== 0) throw new Error(`Expected success: ${safe.txResponse.rawLog}`);
  console.log(`OK: accepted | gasUsed: ${safe.txResponse.gasUsed}`);

  const cooldownAfterSafe = await queryContract<{ unsafe_streak: number; next_unsafe_allowed_at: number | null }>(
    RPC,
    { address: factoryAddress, query: { get_creator_cooldown: { creator: wallet.address } } }
  );
  console.log("Cooldown after the safe-shaped raffle:", cooldownAfterSafe);
  if (
    cooldownAfterSafe.unsafe_streak !== cooldownAfterFirst.unsafe_streak ||
    cooldownAfterSafe.next_unsafe_allowed_at !== cooldownAfterFirst.next_unsafe_allowed_at
  ) {
    throw new Error(
      "Expected the cooldown to be unchanged by the safe-shaped raffle - " +
        "if this fails, the free-reset bug is back"
    );
  }

  console.log("\n4. A second unsafe-shaped raffle right after the safe one - must STILL be rejected...");
  try {
    const fourth = await wallet.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: wallet.address,
          contract: factoryAddress,
          msg: { create_raffle: unsafeFields },
          funds: [],
        }),
      ],
    });
    if (fourth.txResponse.code === 0) {
      throw new Error(
        "Expected this unsafe-shaped raffle to still be rejected (the safe-shaped raffle must not have reset the cooldown), but it succeeded"
      );
    }
    if (!fourth.txResponse.rawLog.includes("cooldown")) {
      throw new Error(`Failed, but not with the expected error: ${fourth.txResponse.rawLog}`);
    }
    console.log("OK: still rejected with a cooldown message - the safe-shaped raffle did not reset it.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("cooldown")) {
      throw new Error(`Failed, but not with the expected error: ${message}`);
    }
    console.log("OK: still rejected with a cooldown message - the safe-shaped raffle did not reset it.");
  }

  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
