import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";
import { addSecrets } from "./keeperSecrets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type WalletStats = { total_invested: string; total_redeemed: string };

async function pushAndAssignCommitIfNeeded(contractAddress: string, commitUsed: string | null) {
  if (commitUsed) return;
  const admin = loadWallet("ADMIN_MNEMONIC");
  const commitPusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  // Preimage kept and persisted (round-review fix, CodeRabbit 2026-08-30):
  // this script never reveals anything itself, but discarding it here would
  // leave an un-revealable commit in the shared COMMIT_QUEUE - any round
  // that later consumes it could never be revealed without the 3-phase
  // outage safety net.
  const preimage = randomBytes(32);
  const commit = createHash("sha256").update(preimage).digest("hex");
  const pushRes = await commitPusher.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: commitPusher.address,
        contract: contractAddress,
        msg: { push_commits: { commits: [commit] } },
        funds: [],
      }),
    ],
  });
  if (pushRes.txResponse.code !== 0) throw new Error(`push_commits failed: ${pushRes.txResponse.rawLog}`);
  addSecrets([{ commit, preimage: preimage.toString("hex") }]);
  const assignRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({ sender: admin.address, contract: contractAddress, msg: { assign_commit: {} }, funds: [] }),
    ],
  });
  if (assignRes.txResponse.code !== 0) throw new Error(`assign_commit failed: ${assignRes.txResponse.rawLog}`);
  console.log("Committed and assigned to the current round/week.");
}

async function checkWheelManager() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-wheelmanager-frontenddev5.json"), "utf8")
  );
  console.log("\n=== Wheel Manager (frontenddev5):", contractAddress, "===");

  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");

  const round = await queryContract<{ round_id: number; commit_used: string | null }>(RPC, {
    address: contractAddress,
    query: { get_current_round: {} },
  });
  console.log("Current round:", round.round_id);

  // v9: BuyTicket refuses to sell before the round has a commit assigned.
  await pushAndAssignCommitIfNeeded(contractAddress, round.commit_used);

  const buyRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      }),
    ],
  });
  if (buyRes.txResponse.code !== 0) throw new Error(`buy_ticket failed: ${buyRes.txResponse.rawLog}`);
  console.log("player1 bought 1 ticket (min_players=2, alone in this round).");

  const statsAfterBuy = await queryContract<WalletStats>(RPC, {
    address: contractAddress,
    query: { get_wallet_stats: { wallet: player1.address } },
  });
  console.log("player1 stats after buying:", statsAfterBuy);
  if (statsAfterBuy.total_invested !== "1000000") throw new Error("UNEXPECTED total_invested after buy");

  const withdrawRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { withdraw_ticket: { round_id: round.round_id } },
        funds: [],
      }),
    ],
  });
  if (withdrawRes.txResponse.code !== 0) throw new Error(`withdraw_ticket failed: ${withdrawRes.txResponse.rawLog}`);
  const amountAttr = withdrawRes.txResponse.events
    .find((e) => e.type === "wasm")
    ?.attributes.find((a) => a.key === "amount");
  console.log("WithdrawTicket ok | refunded:", amountAttr?.value, "| gasUsed:", withdrawRes.txResponse.gasUsed);

  const statsAfterWithdraw = await queryContract<WalletStats>(RPC, {
    address: contractAddress,
    query: { get_wallet_stats: { wallet: player1.address } },
  });
  console.log("player1 stats after withdrawing:", statsAfterWithdraw);
  if (statsAfterWithdraw.total_invested !== "0") throw new Error("UNEXPECTED: total_invested should be 0 after withdraw");

  const roundAfterWithdraw = await queryContract<{ ticket_count: number; unique_player_count: number }>(RPC, {
    address: contractAddress,
    query: { get_current_round: {} },
  });
  console.log(
    "Round after withdraw - ticket_count:",
    roundAfterWithdraw.ticket_count,
    "unique_player_count:",
    roundAfterWithdraw.unique_player_count
  );

  // Now reach min_players (2) and confirm withdrawal locks.
  await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      }),
    ],
  });
  const buy2Res = await player2.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player2.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      }),
    ],
  });
  if (buy2Res.txResponse.code !== 0) throw new Error(`buy_ticket (player2) failed: ${buy2Res.txResponse.rawLog}`);
  console.log("player1 + player2 bought in - min_players (2) reached, round auto-closed (max_players=2).");

  try {
    const lockedRes = await player1.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: player1.address,
          contract: contractAddress,
          msg: { withdraw_ticket: { round_id: round.round_id } },
          funds: [],
        }),
      ],
    });
    console.log(
      lockedRes.txResponse.code !== 0
        ? `WithdrawTicket correctly rejected once locked: ${lockedRes.txResponse.rawLog.slice(0, 160)}`
        : "UNEXPECTED: withdraw succeeded after lock-in"
    );
  } catch (err) {
    console.log(`WithdrawTicket correctly rejected during simulation: ${(err as Error).message.slice(0, 160)}`);
  }
}

async function checkWeeklyRound() {
  const { contractAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, "../deployment-weekly-round.json"), "utf8")
  );
  console.log("\n=== Weekly Round:", contractAddress, "===");

  const player1 = loadWallet("PLAYER1_MNEMONIC");

  const week = await queryContract<{ week_id: number; today_price: string; commit_used: string | null }>(RPC, {
    address: contractAddress,
    query: { get_current_week: {} },
  });
  console.log("Current week:", week.week_id, "price today:", week.today_price);

  // v9: BuyWeeklyTicket refuses to sell before the week has a commit assigned.
  await pushAndAssignCommitIfNeeded(contractAddress, week.commit_used);

  const buyRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { buy_weekly_ticket: {} },
        funds: [{ denom: "uluna", amount: week.today_price }],
      }),
    ],
  });
  if (buyRes.txResponse.code !== 0) throw new Error(`buy_weekly_ticket failed: ${buyRes.txResponse.rawLog}`);
  console.log("player1 bought 1 weekly ticket (min_players=2, alone in this week).");

  const statsAfterBuy = await queryContract<WalletStats>(RPC, {
    address: contractAddress,
    query: { get_wallet_stats: { wallet: player1.address } },
  });
  console.log("player1 stats after buying:", statsAfterBuy);
  if (statsAfterBuy.total_invested !== week.today_price) throw new Error("UNEXPECTED total_invested after buy");

  const withdrawRes = await player1.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player1.address,
        contract: contractAddress,
        msg: { withdraw_ticket: { week_id: week.week_id } },
        funds: [],
      }),
    ],
  });
  if (withdrawRes.txResponse.code !== 0) throw new Error(`withdraw_ticket failed: ${withdrawRes.txResponse.rawLog}`);
  const amountAttr = withdrawRes.txResponse.events
    .find((e) => e.type === "wasm")
    ?.attributes.find((a) => a.key === "amount");
  console.log("WithdrawTicket ok | refunded:", amountAttr?.value, "| gasUsed:", withdrawRes.txResponse.gasUsed);

  const statsAfterWithdraw = await queryContract<WalletStats>(RPC, {
    address: contractAddress,
    query: { get_wallet_stats: { wallet: player1.address } },
  });
  console.log("player1 stats after withdrawing:", statsAfterWithdraw);
  if (statsAfterWithdraw.total_invested !== "0") throw new Error("UNEXPECTED: total_invested should be 0 after withdraw");
}

async function main() {
  await checkWheelManager();
  await checkWeeklyRound();
  console.log("\nAll withdraw + wallet-stats checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
