import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation (2026-07-23): can a single signed transaction carry N
// separate BuyTicket messages (the contract itself has no quantity field),
// letting a wallet buy several tickets with one Keplr signature instead of
// one per ticket?
const [, , label = "frontenddev8"] = process.argv;

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  const creator = loadWallet("PLAYER1_MNEMONIC");
  const buyer = loadWallet("PLAYER2_MNEMONIC");

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
            min_players: 10,
            max_players: 25,
            round_timeout_seconds: 3600,
            draw_delay_blocks: 2,
            draw_window_blocks: 60,
            unclaimed_deadline_days: 90,
            max_raffle_age_seconds: 604800,
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
  await creator.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: creator.address,
        contract: raffleAddress,
        msg: { pay_service_fee: {} },
        funds: [{ denom: config.usdc_denom, amount: config.fee_amount_usdc }],
      }),
    ],
  });
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
  console.log("Raffle funded and open.");

  console.log("\nBuying 3 tickets in a single signed transaction...");
  const batchMsgs = Array.from(
    { length: 3 },
    () =>
      new MsgExecuteContract({
        sender: buyer.address,
        contract: raffleAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      })
  );
  const batchRes = await buyer.broadcastTxSync({ msgs: batchMsgs });
  if (batchRes.txResponse.code !== 0) throw new Error(`Batched BuyTicket failed: ${batchRes.txResponse.rawLog}`);
  console.log(`OK: batched tx succeeded | gasUsed: ${batchRes.txResponse.gasUsed}`);

  const status = await queryContract<{ ticket_count: number; unique_player_count: number }>(RPC, {
    address: raffleAddress,
    query: { get_raffle_status: {} },
  });
  console.log("ticket_count after batch:", status.ticket_count, "| unique_player_count:", status.unique_player_count);
  if (status.ticket_count !== 3) throw new Error(`Expected ticket_count 3, got ${status.ticket_count}`);

  const entrants = await queryContract<{ entrants: string[] }>(RPC, {
    address: raffleAddress,
    query: { get_entrants: {} },
  });
  const buyerTickets = entrants.entrants.filter((a) => a === buyer.address).length;
  console.log("buyer's own ticket count (via GetEntrants):", buyerTickets);
  if (buyerTickets !== 3) throw new Error(`Expected 3 tickets for buyer, got ${buyerTickets}`);

  console.log("\nAll checks passed - one signature bought 3 tickets successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
