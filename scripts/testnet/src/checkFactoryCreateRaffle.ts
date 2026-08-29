import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One-off validation: does a real CreateRaffle -> SubMsg -> reply actually
// register the new raffle? (The one thing the code review couldn't fully
// confirm from source alone - whether this chain's wasmd populates the
// legacy protobuf `data` field cw-utils' parse_reply_instantiate_data reads.)
const [, , label = "frontenddev"] = process.argv;

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const admin = loadWallet("ADMIN_MNEMONIC");

  const before = await queryContract<{ total_count: number }>(RPC, {
    address: factoryAddress,
    query: { get_raffles: {} },
  });
  console.log("Raffles registered before:", before.total_count);

  const res = await admin.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: admin.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            raffle_type: "single_winner",
            ticket_price: "1000000", // $1 - meets the paid-raffle minimum (2026-07-21)
            ticket_denom: "uluna", // paid raffles must use the platform's USDC, which is "uluna" on this testnet (see checkBatchBuyTicket.ts) - "utestusdc" doesn't exist and the factory would reject it
            allowed_entrants: null,
            min_players: 2,
            // >= UNSAFE_MAX_PLAYERS_THRESHOLD (20) in the factory's cooldown
            // check (2026-07-22) - keeps this "safe-shaped" so re-running
            // this script never collides with the anti-spam cooldown for
            // repeat unsafe-shaped raffles from the same admin wallet.
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
  console.log(`create_raffle tx ok | gasUsed: ${res.txResponse.gasUsed}`);

  const instantiateEvent = res.txResponse.events.find((e) => e.type === "instantiate");
  const newRaffleAddr = instantiateEvent?.attributes.find((a) => a.key === "_contract_address")?.value;
  console.log("New raffle address (from tx events):", newRaffleAddr);

  const after = await queryContract<{
    total_count: number;
    raffles: { index: number; address: string; creator: string; created_at: number }[];
  }>(RPC, {
    address: factoryAddress,
    query: { get_raffles: {} },
  });
  console.log("Raffles registered after:", after.total_count);
  console.log("Latest registered raffle:", after.raffles[0]);

  if (after.total_count !== before.total_count + 1) {
    throw new Error("total_count did not increase by 1 - registration failed");
  }
  if (after.raffles[0].address !== newRaffleAddr) {
    throw new Error(
      `Registered address (${after.raffles[0].address}) does not match the tx's actual new contract address (${newRaffleAddr}) - reply parsing may be broken`
    );
  }
  if (after.raffles[0].creator !== admin.address) {
    throw new Error("Registered creator does not match the sender");
  }
  console.log("OK: reply correctly parsed the new contract address and registered it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
