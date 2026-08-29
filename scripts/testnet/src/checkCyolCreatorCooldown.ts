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
  ticket_denom: "uluna", // paid raffles must use the platform's USDC, which is "uluna" on this testnet (see checkBatchBuyTicket.ts) - "utestusdc" doesn't exist and the factory would reject it
  allowed_entrants: null,
  min_players: 2,
  max_players: 10, // < 20 -> unsafe shape
  round_timeout_seconds: 86_400, // contract MIN as of the round-10 audit fix (raised from 1h)
  unclaimed_deadline_days: 90,
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
  // succeeded/errorMessage, both checked strictly after the try/catch
  // (round-13 audit fix, Opus): round 12 only hoisted the "but it
  // succeeded" case out of the try - the "wrong error" throw was still
  // inside it, so a non-cooldown rejection (e.g. out of gas, a stale
  // factory code_id) still got caught by this same block's own catch and
  // double-wrapped into "Failed, but not with the expected error: Failed,
  // but not with the expected error: <rawLog>". Neither check runs until
  // both possible outcomes (a rejected tx response, or a thrown exception)
  // have been reduced to one plain message first.
  let secondSucceeded = false;
  let secondErrorMessage: string | null = null;
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
      secondSucceeded = true;
    } else {
      secondErrorMessage = second.txResponse.rawLog;
    }
  } catch (err) {
    secondErrorMessage = err instanceof Error ? err.message : String(err);
  }
  if (secondSucceeded) {
    throw new Error("Expected the second unsafe-shaped raffle to fail, but it succeeded");
  }
  if (!secondErrorMessage?.includes("cooldown")) {
    throw new Error(`Failed, but not with the expected error: ${secondErrorMessage}`);
  }
  console.log("OK: rejected with a cooldown message.");

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
  // fourthSucceeded/fourthErrorMessage, both checked strictly after the
  // try/catch (round-12 audit fix, Opus, for the false-pass half; round-13
  // audit fix, Opus, for the remaining double-wrap half - same reasoning as
  // step 2 above). Round 12 closed the real bug here: the old "but it
  // succeeded" throw's own message contained the substring "cooldown"
  // ("...the safe-shaped raffle must not have reset the cooldown..."), so a
  // regression of the free-reset bug this step exists to catch (the
  // cooldown wrongly cleared, so the 4th create_raffle actually succeeds)
  // would have been swallowed by this block's own catch and printed as a
  // false "OK: still rejected" / "All checks passed."
  let fourthSucceeded = false;
  let fourthErrorMessage: string | null = null;
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
      fourthSucceeded = true;
    } else {
      fourthErrorMessage = fourth.txResponse.rawLog;
    }
  } catch (err) {
    fourthErrorMessage = err instanceof Error ? err.message : String(err);
  }
  if (fourthSucceeded) {
    throw new Error(
      "Expected this unsafe-shaped raffle to still be rejected (the safe-shaped raffle must not have reset the cooldown), but it succeeded"
    );
  }
  if (!fourthErrorMessage?.includes("cooldown")) {
    throw new Error(`Failed, but not with the expected error: ${fourthErrorMessage}`);
  }
  console.log("OK: still rejected with a cooldown message - the safe-shaped raffle did not reset it.");

  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
