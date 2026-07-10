import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { GAS_PRICE, RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATH = path.resolve(__dirname, "../deployment.json");

// 1 LUNC per ticket - arbitrary for this test, only the tax/gas behavior matters.
const TICKET_AMOUNT = "1000000";
const GAS_ACCEPTANCE_THRESHOLD_PCT = 10;

type TxEvent = { type: string; attributes: { key: string; value: string }[] };

function logEvents(label: string, events: TxEvent[]) {
  console.log(`--- events: ${label} ---`);
  for (const e of events) {
    const attrs = Object.fromEntries(e.attributes.map((a) => [a.key, a.value]));
    console.log(` ${e.type}`, attrs);
  }
}

function hasTaxPayment(events: TxEvent[]): boolean {
  return events.some((e) => e.type === "tax_payment");
}

async function main() {
  const { contractAddress } = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  console.log("Contract:", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");

  console.log("\nPlayer1 buying ticket...");
  const buy1 = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: TICKET_AMOUNT }],
      }),
    ],
  });
  if (buy1.txResponse.code !== 0) throw new Error(`buy1 failed: ${buy1.txResponse.rawLog}`);
  logEvents("player1 buy_ticket", buy1.txResponse.events);
  console.log(
    `player1 buy_ticket -> tax_payment event: ${hasTaxPayment(buy1.txResponse.events)} | gasUsed: ${buy1.txResponse.gasUsed}`
  );

  console.log("\nPlayer2 buying ticket...");
  const buy2 = await player2.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player2.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: TICKET_AMOUNT }],
      }),
    ],
  });
  if (buy2.txResponse.code !== 0) throw new Error(`buy2 failed: ${buy2.txResponse.rawLog}`);
  console.log(
    `player2 buy_ticket -> tax_payment event: ${hasTaxPayment(buy2.txResponse.events)} | gasUsed: ${buy2.txResponse.gasUsed}`
  );

  const state = await queryContract<{ pool: string; winner: string | null; redeemed: boolean }>(
    RPC,
    { address: contractAddress, query: { state: {} } }
  );
  console.log("\nContract state after both tickets:", state);
  const pool = BigInt(state.pool);

  console.log("\nAdmin setting winner = player1...");
  const setWinner = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: contractAddress,
        msg: { set_winner: { winner: player1.address } },
        funds: [],
      }),
    ],
  });
  if (setWinner.txResponse.code !== 0) {
    throw new Error(`set_winner failed: ${setWinner.txResponse.rawLog}`);
  }
  console.log(`set_winner ok | gasUsed: ${setWinner.txResponse.gasUsed}`);

  console.log("\nPlayer1 redeeming...");
  const redeem = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { redeem: {} },
        funds: [],
      }),
    ],
  });
  if (redeem.txResponse.code !== 0) throw new Error(`redeem failed: ${redeem.txResponse.rawLog}`);
  logEvents("player1 redeem", redeem.txResponse.events);

  const gasUsed = redeem.txResponse.gasUsed;
  const gasPrice = Number(GAS_PRICE.amount);
  const gasCost = Number(gasUsed) * gasPrice;
  const gasCostPct = (gasCost / Number(pool)) * 100;

  console.log("\n=== REPORT ===");
  console.log(`Prize pool: ${pool} uluna`);
  console.log(
    `BuyTicket incoming funds tax-free (no tax_payment event): player1=${!hasTaxPayment(buy1.txResponse.events)}, player2=${!hasTaxPayment(buy2.txResponse.events)}`
  );
  console.log(`Redeem tax_payment event present: ${hasTaxPayment(redeem.txResponse.events)}`);
  console.log(`Redeem gasUsed: ${gasUsed} | estimated gas cost: ${gasCost.toFixed(0)} uluna (${gasCostPct.toFixed(2)}% of the prize)`);
  console.log(
    gasCostPct <= GAS_ACCEPTANCE_THRESHOLD_PCT
      ? `OK: under the ${GAS_ACCEPTANCE_THRESHOLD_PCT}% threshold`
      : `WARNING: exceeds the ${GAS_ACCEPTANCE_THRESHOLD_PCT}% threshold`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
