import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation (2026-07-23) for the creator-field fix: does a raffle
// created through the factory end up with its OWN config.creator set to the
// real caller (not the factory's address), and can that real caller
// actually call DepositPrize successfully?
const [, , label = "frontenddev8"] = process.argv;

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const player = loadWallet("PLAYER1_MNEMONIC");
  console.log("Real creator wallet:", player.address);

  const res = await player.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player.address,
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
            draw_delay_blocks: 2,
            draw_window_blocks: 60,
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
  const instantiateEvent = res.txResponse.events.find((e) => e.type === "instantiate");
  const raffleAddress = instantiateEvent?.attributes.find((a) => a.key === "_contract_address")?.value;
  if (!raffleAddress) throw new Error("No raffle address in tx events");
  console.log("New raffle address:", raffleAddress);

  const config = await queryContract<{ creator: string; fee_amount_usdc: string; usdc_denom: string }>(RPC, {
    address: raffleAddress,
    query: { get_config: {} },
  });
  console.log("Raffle's own config.creator:", config.creator);

  if (config.creator !== player.address) {
    throw new Error(
      `BUG STILL PRESENT: config.creator (${config.creator}) does not match the real caller (${player.address}) - it's probably the factory's own address again.`
    );
  }
  console.log("OK: config.creator matches the real human wallet, not the factory.");

  // Prize denom ("uluna") is the same as usdc_denom on this testnet
  // (2026-07-23) - the contract requires PayServiceFee first in that case,
  // it can't tell prize and fee apart in a single combined coin.
  console.log(`\nPaying the service fee (${config.fee_amount_usdc}${config.usdc_denom})...`);
  const feeRes = await player.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player.address,
        contract: raffleAddress,
        msg: { pay_service_fee: {} },
        funds: [{ denom: config.usdc_denom, amount: config.fee_amount_usdc }],
      }),
    ],
  });
  if (feeRes.txResponse.code !== 0) throw new Error(`PayServiceFee failed: ${feeRes.txResponse.rawLog}`);
  console.log(`OK: PayServiceFee succeeded | gasUsed: ${feeRes.txResponse.gasUsed}`);

  console.log("\nAttempting DepositPrize as the real creator (the exact action that was impossible before)...");
  const depositRes = await player.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: player.address,
        contract: raffleAddress,
        msg: { deposit_prize: {} },
        funds: [{ denom: "uluna", amount: "10000000" }],
      }),
    ],
  });
  if (depositRes.txResponse.code !== 0) {
    throw new Error(`DepositPrize failed: ${depositRes.txResponse.rawLog}`);
  }
  console.log(`OK: DepositPrize succeeded | gasUsed: ${depositRes.txResponse.gasUsed}`);

  const status = await queryContract<{ status: string }>(RPC, {
    address: raffleAddress,
    query: { get_raffle_status: {} },
  });
  console.log("Raffle status after funding:", status.status);
  if (status.status !== "open") throw new Error(`Expected status "open", got "${status.status}"`);

  console.log("\nBuying a ticket as a second wallet (player2)...");
  const buyer = loadWallet("PLAYER2_MNEMONIC");
  const buyRes = await buyer.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: buyer.address,
        contract: raffleAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: "uluna", amount: "1000000" }],
      }),
    ],
  });
  if (buyRes.txResponse.code !== 0) throw new Error(`BuyTicket failed: ${buyRes.txResponse.rawLog}`);
  console.log(`OK: BuyTicket succeeded | gasUsed: ${buyRes.txResponse.gasUsed}`);

  console.log("\nAll checks passed - the fix works end-to-end on real chain (funding + ticket purchase).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
