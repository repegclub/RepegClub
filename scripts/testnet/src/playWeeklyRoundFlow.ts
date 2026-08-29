import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, getNativeBalances, queryContract } from "@goblinhunt/cosmes/client";

import { ADMIN_FEE_ADDRESS, RPC, TREASURY_ADDRESS, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATH = path.resolve(__dirname, "../deployment-weekly-round.json");

async function ulunaBalance(address: string): Promise<bigint> {
  const balances = await getNativeBalances(RPC, { address });
  const uluna = balances.find((c) => c.denom === "uluna");
  return uluna ? BigInt(uluna.amount) : 0n;
}

async function main() {
  const { contractAddress } = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  console.log("Weekly Round:", contractAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");
  const commitPusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  const player1 = loadWallet("PLAYER1_MNEMONIC");
  const player2 = loadWallet("PLAYER2_MNEMONIC");

  // v9: BuyWeeklyTicket refuses to sell before the week has a commit assigned
  // - push one and back-fill it onto week 1 before anyone buys. Hex string,
  // not base64 - see wheel-manager's matching play script for why.
  const preimage = randomBytes(32);
  const commit = createHash("sha256").update(preimage).digest("hex");
  console.log(`\nPushing commit ${commit}...`);
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
  const assignRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({ sender: admin.address, contract: contractAddress, msg: { assign_commit: {} }, funds: [] }),
    ],
  });
  if (assignRes.txResponse.code !== 0) throw new Error(`assign_commit failed: ${assignRes.txResponse.rawLog}`);
  console.log("  committed and assigned to week 1");

  const priceBin = await queryContract<{ price: string; denom: string }>(RPC, {
    address: contractAddress,
    query: { get_today_price: {} },
  });
  console.log("Today's price:", priceBin.price, priceBin.denom);

  const [treasuryBefore, adminFeeBefore] = await Promise.all([
    ulunaBalance(TREASURY_ADDRESS),
    ulunaBalance(ADMIN_FEE_ADDRESS),
  ]);

  for (const player of [player1, player2]) {
    console.log(`\n${player.address} buying weekly ticket...`);
    const res = await player.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: player.address,
          contract: contractAddress,
          msg: { buy_weekly_ticket: {} },
          funds: [{ denom: "uluna", amount: priceBin.price }],
        }),
      ],
    });
    if (res.txResponse.code !== 0) throw new Error(`buy_weekly_ticket failed: ${res.txResponse.rawLog}`);
    const autoClosed = res.txResponse.events
      .find((e) => e.type === "wasm")
      ?.attributes.find((a) => a.key === "auto_closed")?.value;
    console.log(`  ok | gasUsed: ${res.txResponse.gasUsed} | auto_closed: ${autoClosed}`);
  }

  console.log("\nRevealing draw...");
  const drawRes = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: contractAddress,
        msg: { reveal_draw: { week_id: 1, preimage: preimage.toString("hex") } },
        funds: [],
      }),
    ],
  });
  if (drawRes.txResponse.code !== 0) {
    throw new Error(`reveal_draw failed: ${drawRes.txResponse.rawLog}`);
  }
  const wasmEvent = drawRes.txResponse.events.find((e) => e.type === "wasm");
  const winner = wasmEvent?.attributes.find((a) => a.key === "winner")?.value;
  const prize = wasmEvent?.attributes.find((a) => a.key === "prize")?.value;
  if (!winner || !prize) throw new Error("winner/prize not found in reveal_draw events");
  console.log(`Winner: ${winner} | prize: ${prize} uluna | gasUsed: ${drawRes.txResponse.gasUsed}`);

  const winnerWallet = [player1, player2].find((p) => p.address === winner);
  if (!winnerWallet) throw new Error("winner is not one of our loaded player wallets");

  console.log(`\n${winner} redeeming week 1...`);
  const redeemRes = await winnerWallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: winner,
        contract: contractAddress,
        msg: { redeem: { week_id: 1 } },
        funds: [{ denom: "uluna", amount: prize }],
      }),
    ],
  });
  if (redeemRes.txResponse.code !== 0) throw new Error(`redeem failed: ${redeemRes.txResponse.rawLog}`);
  console.log(`Redeemed | gasUsed: ${redeemRes.txResponse.gasUsed}`);

  const [treasuryAfter, adminFeeAfter] = await Promise.all([
    ulunaBalance(TREASURY_ADDRESS),
    ulunaBalance(ADMIN_FEE_ADDRESS),
  ]);

  const grossPool = 2n * BigInt(priceBin.price);
  console.log("\n=== REPORT ===");
  console.log(`Gross pool: ${grossPool} uluna`);
  console.log(`Prize paid to winner: ${prize} uluna (expected 85%: ${(grossPool * 85n) / 100n})`);
  console.log(
    `Treasury delta: ${treasuryAfter - treasuryBefore} uluna (expected 12%+dust: ~${(grossPool * 12n) / 100n})`
  );
  console.log(
    `Admin fee delta: ${adminFeeAfter - adminFeeBefore} uluna (expected 3%: ${(grossPool * 3n) / 100n})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
