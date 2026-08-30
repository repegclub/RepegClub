import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation (2026-07-24) for the new CreatorForm whitelist field:
// a raffle created with a non-null allowed_entrants should let a listed
// wallet buy a ticket and reject one that isn't listed. This field was
// always sent as null from the frontend before today, so this is the first
// time create_raffle carries a real list through the factory's reply flow.
const [, , label = "frontenddev8"] = process.argv;

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const creator = loadWallet("PLAYER1_MNEMONIC");
  const allowed = loadWallet("PLAYER1_MNEMONIC");
  const notAllowed = loadWallet("PLAYER2_MNEMONIC");
  console.log("Creator / whitelisted wallet:", creator.address);
  console.log("Non-whitelisted wallet:", notAllowed.address);

  const res = await creator.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: creator.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            raffle_type: "single_winner",
            ticket_price: "1000000",
            ticket_denom: "uluna",
            allowed_entrants: [allowed.address],
            min_players: 2,
            max_players: 25,
            round_timeout_seconds: 86_400, // contract MIN as of the round-10 audit fix (raised from 1h)
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
  if (res.txResponse.code !== 0) throw new Error(`create_raffle failed: ${res.txResponse.rawLog}`);
  const raffleAddress = res.txResponse.events
    .find((e) => e.type === "instantiate")
    ?.attributes.find((a) => a.key === "_contract_address")?.value;
  if (!raffleAddress) throw new Error("No raffle address in tx events");
  console.log("New raffle address:", raffleAddress);

  const config = await queryContract<{ allowed_entrants: string[] | null; fee_amount_usdc: string; usdc_denom: string }>(
    RPC,
    { address: raffleAddress, query: { get_config: {} } }
  );
  console.log("Raffle's own config.allowed_entrants:", config.allowed_entrants);
  if (!config.allowed_entrants || config.allowed_entrants.length !== 1 || config.allowed_entrants[0] !== allowed.address) {
    throw new Error("allowed_entrants on-chain doesn't match what was sent.");
  }
  console.log("OK: allowed_entrants round-tripped correctly through the factory.");

  // v9: funding triggers ConsumeCommit against the factory's queue - push one
  // first or that call fails with NoCommitsAvailable.
  const commitPusher = loadWallet("COMMIT_PUSHER_MNEMONIC");
  const commit = createHash("sha256").update(randomBytes(32)).digest("hex");
  const pushRes = await commitPusher.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: commitPusher.address,
        contract: factoryAddress,
        msg: { push_commits: { commits: [commit] } },
        funds: [],
      }),
    ],
  });
  if (pushRes.txResponse.code !== 0) throw new Error(`push_commits failed: ${pushRes.txResponse.rawLog}`);

  console.log(`\nPaying the service fee (${config.fee_amount_usdc}${config.usdc_denom})...`);
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
  console.log("OK: raffle funded and open.");

  console.log("\nAttempting BuyTicket as the NON-whitelisted wallet (should be rejected)...");
  try {
    await notAllowed.broadcastTxSync({
      msgs: [
        new MsgExecuteContract({
          sender: notAllowed.address,
          contract: raffleAddress,
          msg: { buy_ticket: {} },
          funds: [{ denom: "uluna", amount: "1000000" }],
        }),
      ],
    });
    throw new Error("BUG: non-whitelisted wallet was able to buy a ticket.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("not in the allowlist")) throw err;
    console.log("OK: rejected as expected -", message.split("\n")[0]);
  }

  console.log("\nAttempting BuyTicket as the whitelisted wallet (should succeed)...");
  const allowedRes = await allowed.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: allowed.address,
        contract: raffleAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      }),
    ],
  });
  if (allowedRes.txResponse.code !== 0) throw new Error(`BuyTicket failed for whitelisted wallet: ${allowedRes.txResponse.rawLog}`);
  console.log(`OK: whitelisted wallet bought a ticket | gasUsed: ${allowedRes.txResponse.gasUsed}`);

  console.log("\nAll checks passed - allowed_entrants works end-to-end on real chain.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
