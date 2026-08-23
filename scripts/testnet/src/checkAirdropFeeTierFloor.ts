import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { loadWallet, RPC } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off live validation (2026-08-23): a paid Airdrop's fee must never be
// cheaper than a free Airdrop of the same max_players - see
// contract.rs's required_fee_usdc doc comment. $1 ticket / 1000 max_players
// must now charge the $18 free-tier floor, not the ~$10 pure-revenue number.
const [, , label = "frontenddev11"] = process.argv;

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);
  const admin = loadWallet("ADMIN_MNEMONIC");

  const res = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            raffle_type: "airdrop",
            ticket_price: "1000000", // $1
            ticket_denom: "uluna",
            allowed_entrants: null,
            min_players: 2,
            max_players: 1000,
            round_timeout_seconds: 86_400,
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
  const addr = res.txResponse.events.find((e) => e.type === "instantiate")?.attributes.find((a) => a.key === "_contract_address")?.value;
  if (!addr) throw new Error("raffle address not found in tx events");
  console.log("Raffle:", addr);

  const config = await queryContract<{ fee_amount_usdc: string }>(RPC, {
    address: addr,
    query: { get_config: {} },
  });
  console.log("fee_amount_usdc:", config.fee_amount_usdc);
  if (config.fee_amount_usdc !== "18000000") {
    throw new Error(`expected 18000000 (the $18 free-tier floor), got ${config.fee_amount_usdc}`);
  }
  console.log("OK: paid Airdrop at $1/1000 players charges the $18 tier floor, not the cheaper revenue-based fee.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
