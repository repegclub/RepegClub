import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation (2026-07-25) of the grinding-resistance mechanism in
// execute_draw_winner (contracts/create-your-own-luck/src/execute.rs):
// - DrawWinner is creator-exclusive at first (rejects a non-creator).
// - Calling it once the draw window has elapsed rearms instead of erroring,
//   up to MAX_REARMS_BEFORE_PERMISSIONLESS (2) times.
// - Once that cap is spent, a non-creator can draw successfully.
// Uses draw_delay_blocks=1 / draw_window_blocks=1 (the contract's own
// minimums) so the whole cycle takes a handful of blocks instead of the
// platform's real 2/60 production values.
const [, , label = "frontenddev8"] = process.argv;

async function currentHeight(): Promise<number> {
  const res = await fetch(`${RPC}/status`);
  const body = await res.json();
  return Number(body.result.sync_info.latest_block_height);
}

async function waitForHeight(target: number) {
  for (;;) {
    const height = await currentHeight();
    if (height >= target) {
      console.log(`Reached height ${height} (target ${target}).`);
      return;
    }
    process.stdout.write(`  height ${height}, waiting for ${target}...\r`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const creator = loadWallet("PLAYER1_MNEMONIC");
  const buyer1 = loadWallet("PLAYER2_MNEMONIC");
  const buyer2 = loadWallet("PLAYER3_MNEMONIC");
  const outsider = loadWallet("ADMIN_MNEMONIC"); // never touches this raffle otherwise
  console.log("Creator:", creator.address);
  console.log("Outsider (proves permissionless, never bought a ticket here):", outsider.address);

  const createRes = await creator.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: creator.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            raffle_type: "single_winner",
            ticket_price: "1000000",
            ticket_denom: "uluna",
            allowed_entrants: null,
            min_players: 2,
            max_players: 25,
            round_timeout_seconds: 86_400, // contract MIN as of the round-10 audit fix (raised from 1h)
            draw_delay_blocks: 1,
            draw_window_blocks: 1,
            unclaimed_deadline_days: 90,
            prize_native_denom: "uluna",
            prize_cw20_address: null,
            podium_shares_bps: [],
          },
        },
        funds: [],
      }),
    ],
  });
  if (createRes.txResponse.code !== 0) throw new Error(`create_raffle failed: ${createRes.txResponse.rawLog}`);
  const raffleAddress = createRes.txResponse.events
    .find((e) => e.type === "instantiate")
    ?.attributes.find((a) => a.key === "_contract_address")?.value;
  if (!raffleAddress) throw new Error("No raffle address in tx events");
  console.log("Raffle:", raffleAddress);

  const config = await queryContract<{ fee_amount_usdc: string; usdc_denom: string }>(RPC, {
    address: raffleAddress,
    query: { get_config: {} },
  });

  console.log("\nPaying service fee + depositing prize...");
  const feeRes = await creator.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: creator.address,
        contract: raffleAddress,
        msg: { pay_service_fee: {} },
        funds: [{ denom: config.usdc_denom, amount: config.fee_amount_usdc }],
      }),
    ],
  });
  if (feeRes.txResponse.code !== 0) throw new Error(`PayServiceFee failed: ${feeRes.txResponse.rawLog}`);
  const depositRes = await creator.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: creator.address,
        contract: raffleAddress,
        msg: { deposit_prize: {} },
        funds: [{ denom: "uluna", amount: "10000000" }],
      }),
    ],
  });
  if (depositRes.txResponse.code !== 0) throw new Error(`DepositPrize failed: ${depositRes.txResponse.rawLog}`);
  console.log("Funded and open.");

  console.log("\nBuying tickets from 2 wallets to reach min_players...");
  for (const buyer of [buyer1, buyer2]) {
    const res = await buyer.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: buyer.address,
          contract: raffleAddress,
          msg: { buy_ticket: {} },
          funds: [{ denom: "uluna", amount: "1000000" }],
        }),
      ],
    });
    if (res.txResponse.code !== 0) throw new Error(`BuyTicket failed: ${res.txResponse.rawLog}`);
  }
  console.log("2 unique players in - min_players reached.");

  console.log("\nCreator closes the round early...");
  const closeRes = await creator.broadcastTxSync({
    msgs: [new MsgExecuteContract({ sender: creator.address, contract: raffleAddress, msg: { close_round: {} }, funds: [] })],
  });
  if (closeRes.txResponse.code !== 0) throw new Error(`CloseRound failed: ${closeRes.txResponse.rawLog}`);
  console.log("Closed.");

  console.log("\n[Control check] Outsider tries DrawWinner immediately (should be REJECTED - not yet past cap or deadline)...");
  try {
    await outsider.broadcastTxSync({
      msgs: [new MsgExecuteContract({ sender: outsider.address, contract: raffleAddress, msg: { draw_winner: {} }, funds: [] })],
    });
    throw new Error("BUG: a non-creator was able to draw before the rearm cap was spent.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes("unauthorized")) throw err;
    console.log("OK: rejected as expected -", message.split("\n")[0]);
  }

  async function drawAfterHeight(): Promise<number | null> {
    const status = await queryContract<{ draw_after_height: number | null }>(RPC, {
      address: raffleAddress!,
      query: { get_raffle_status: {} },
    });
    return status.draw_after_height;
  }

  for (let expectedRearm = 1; expectedRearm <= 2; expectedRearm++) {
    const requiredHeight = await drawAfterHeight();
    if (requiredHeight === null) throw new Error("draw_after_height was null - unexpected before any draw attempt.");
    // draw_window_blocks=1, so the window is spent one block past required_height.
    console.log(`\nWaiting for the draw window to elapse (need height >= ${requiredHeight + 1})...`);
    await waitForHeight(requiredHeight + 1);

    console.log(`Creator calls DrawWinner (expecting rearm #${expectedRearm})...`);
    const rearmRes = await creator.broadcastTxSync({
      msgs: [new MsgExecuteContract({ sender: creator.address, contract: raffleAddress, msg: { draw_winner: {} }, funds: [] })],
    });
    if (rearmRes.txResponse.code !== 0) throw new Error(`DrawWinner (rearm attempt) failed: ${rearmRes.txResponse.rawLog}`);
    const action = rearmRes.txResponse.events.find((e) => e.type === "wasm")?.attributes.find((a) => a.key === "action")?.value;
    const rearmCount = rearmRes.txResponse.events
      .find((e) => e.type === "wasm")
      ?.attributes.find((a) => a.key === "rearm_count")?.value;
    if (action !== "rearm_draw_window") throw new Error(`Expected action "rearm_draw_window", got "${action}"`);
    if (rearmCount !== String(expectedRearm)) throw new Error(`Expected rearm_count ${expectedRearm}, got ${rearmCount}`);
    console.log(`OK: rearmed (rearm_count=${rearmCount}).`);
  }

  console.log("\nRearm cap now spent (2/2) - waiting only for draw_delay_blocks, not the full window this time...");
  const finalRequiredHeight = await drawAfterHeight();
  if (finalRequiredHeight === null) throw new Error("draw_after_height was null after the 2nd rearm.");
  await waitForHeight(finalRequiredHeight);

  console.log("\n[Main check] Outsider (never bought a ticket here) calls DrawWinner - should succeed now, permissionlessly...");
  const finalRes = await outsider.broadcastTxSync({
    msgs: [new MsgExecuteContract({ sender: outsider.address, contract: raffleAddress, msg: { draw_winner: {} }, funds: [] })],
  });
  if (finalRes.txResponse.code !== 0) throw new Error(`Permissionless DrawWinner failed: ${finalRes.txResponse.rawLog}`);
  const finalAction = finalRes.txResponse.events.find((e) => e.type === "wasm")?.attributes.find((a) => a.key === "action")?.value;
  if (finalAction !== "draw_winner") throw new Error(`Expected action "draw_winner", got "${finalAction}"`);
  const winners = finalRes.txResponse.events.find((e) => e.type === "wasm")?.attributes.find((a) => a.key === "winners")?.value;
  console.log(`OK: drew successfully as a non-creator outsider. Winner(s): ${winners}`);

  console.log("\nAll checks passed - the creator-exclusivity, rearm cap, and permissionless fallback all behave as documented.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
