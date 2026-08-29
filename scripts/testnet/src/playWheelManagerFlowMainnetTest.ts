import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract } from "@goblinhunt/cosmes/client";

import { USDC_DENOM, USTC_DENOM, loadWallet } from "./configMainnetTest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// node src/playWheelManagerFlowMainnetTest.ts
// Requires MAINNET_TEST_ADMIN_MNEMONIC and MAINNET_TEST_PLAYER2_MNEMONIC set
// as real environment variables (export them in your shell, never write real
// mnemonics to a file) - two fresh, disposable wallets, each already funded
// by hand (via Keplr) with a bit of LUNC for gas, the ticket price in USDC,
// and a bit of USTC in case that wallet wins and needs to redeem. Also
// requires a deployment already produced by deployWheelManagerMainnetTest.ts.
const deploymentPath = path.resolve(__dirname, "../deployment-wheelmanager-mainnet-test.json");

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prints every event of a tx and flags any tax-related one, so the burn-tax
// question this whole test exists for is answered directly from the raw
// chain data, not inferred.
function reportTax(label: string, events: { type: string; attributes: { key: string; value: string }[] }[]) {
  const taxEvents = events.filter((e) => e.type.includes("tax"));
  if (taxEvents.length === 0) {
    console.log(`  [${label}] no tax event found in this tx's events.`);
  } else {
    console.log(`  [${label}] TAX EVENT FOUND:`);
    for (const e of taxEvents) {
      console.log(`    ${e.type}:`, e.attributes.map((a) => `${a.key}=${a.value}`).join(", "));
    }
  }
}

async function main() {
  const { contractAddress, ticketPrice } = JSON.parse(readFileSync(deploymentPath, "utf8"));
  console.log("Wheel Manager (mainnet test):", contractAddress);
  console.log("Ticket price:", ticketPrice, USDC_DENOM);

  const admin = loadWallet("MAINNET_TEST_ADMIN_MNEMONIC");
  const player2 = loadWallet("MAINNET_TEST_PLAYER2_MNEMONIC");
  console.log("Admin (player 1):", admin.address);
  console.log("Player 2:", player2.address);

  // v9: BuyTicket refuses to sell before the round has a commit assigned.
  // deployWheelManagerMainnetTest.ts set commit_pusher to admin's own wallet
  // (disposable test deploy, same reasoning as treasury/admin_fee there) -
  // hex string, not base64, see the testnet play script for why.
  const preimage = randomBytes(32);
  const commit = createHash("sha256").update(preimage).digest("hex");
  console.log(`\nPushing commit ${commit}...`);
  const pushRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: contractAddress,
        msg: { push_commits: { commits: [commit] } },
        funds: [],
      }),
    ],
  });
  if (pushRes.txResponse.code !== 0) throw new Error(`push_commits failed: ${pushRes.txResponse.rawLog}`);
  const assignRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({ sender: admin.address, contract: contractAddress, msg: { assign_commit: {} }, funds: [] }),
    ],
  });
  if (assignRes.txResponse.code !== 0) throw new Error(`assign_commit failed: ${assignRes.txResponse.rawLog}`);
  console.log("  committed and assigned to round 1");

  const players = [admin, player2];
  for (const [i, player] of players.entries()) {
    console.log(`\n${player.address} (player ${i + 1}) buying ticket...`);
    const res = await player.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: player.address,
          contract: contractAddress,
          msg: { buy_ticket: {} },
          funds: [{ denom: USDC_DENOM, amount: ticketPrice }],
        }),
      ],
    });
    if (res.txResponse.code !== 0) throw new Error(`buy_ticket failed: ${res.txResponse.rawLog}`);
    console.log(`  ok | gasUsed: ${res.txResponse.gasUsed}`);
    reportTax(`buy_ticket player${i + 1}`, res.txResponse.events);
  }

  console.log("\nWaiting for the rolling close deadline (round_timeout_seconds=30) plus buffer...");
  await sleep(35_000);

  console.log("Closing round...");
  let closeRes;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      closeRes = await admin.broadcastTxSync({
        msgs: [
          new MsgExecuteContract({
            sender: admin.address,
            contract: contractAddress,
            msg: { close_round: {} },
            funds: [],
          }),
        ],
      });
      if (closeRes.txResponse.code === 0) break;
      throw new Error(closeRes.txResponse.rawLog);
    } catch (err) {
      console.log(`  attempt ${attempt} not ready yet, waiting 6s... (${(err as Error).message.slice(0, 100)})`);
      closeRes = undefined;
      await sleep(6000);
    }
  }
  if (!closeRes || closeRes.txResponse.code !== 0) throw new Error("close_round never succeeded");
  console.log(`  ok | gasUsed: ${closeRes.txResponse.gasUsed}`);

  console.log("\nRevealing draw...");
  const drawRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: contractAddress,
        msg: { reveal_draw: { round_id: 1, preimage: preimage.toString("hex") } },
        funds: [],
      }),
    ],
  });
  if (drawRes.txResponse.code !== 0) throw new Error(`reveal_draw failed: ${drawRes.txResponse.rawLog}`);
  const wasmEvent = drawRes.txResponse.events.find((e) => e.type === "wasm");
  const winner = wasmEvent?.attributes.find((a) => a.key === "winner")?.value;
  const prize = wasmEvent?.attributes.find((a) => a.key === "prize")?.value;
  if (!winner || !prize) throw new Error("winner/prize not found in reveal_draw events");
  console.log(`Winner: ${winner} | prize: ${prize} ${USDC_DENOM} | gasUsed: ${drawRes.txResponse.gasUsed}`);
  reportTax("reveal_draw (payouts to treasury/admin/weekly)", drawRes.txResponse.events);

  const winnerWallet = players.find((p) => p.address === winner);
  if (!winnerWallet) throw new Error("winner is not admin or player2");

  console.log(`\n${winner} redeeming (sending ${prize} ${USTC_DENOM})...`);
  const redeemRes = await winnerWallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: winner,
        contract: contractAddress,
        msg: { redeem: { round_id: 1 } },
        funds: [{ denom: USTC_DENOM, amount: prize }],
      }),
    ],
  });
  if (redeemRes.txResponse.code !== 0) {
    throw new Error(`redeem failed: ${redeemRes.txResponse.rawLog}`);
  }
  console.log(`Redeemed | gasUsed: ${redeemRes.txResponse.gasUsed}`);
  reportTax("redeem (USTC in as funds, USDC out via BankMsg::Send)", redeemRes.txResponse.events);

  console.log("\n=== DONE ===");
  console.log("Review the [tax event] lines above for buy_ticket, draw_winner, and redeem.");
  console.log("Theory (docs/terra-classic-chain-notes.md): none of them should show a tax event -");
  console.log("funds attached to MsgExecuteContract are tax-free, and USDC/USTC aren't taxable denoms.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
