import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MsgExecuteContract, getNativeBalances, queryContract } from "@goblinhunt/cosmes/client";

import { RPC, loadWallet } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ulunaBalance(address: string): Promise<bigint> {
  const balances = await getNativeBalances(RPC, { address });
  const uluna = balances.find((c) => c.denom === "uluna");
  return uluna ? BigInt(uluna.amount) : 0n;
}

// End-to-end Airdrop flow, never live-tested before (SingleWinner already
// was) - creates a real 3-player Airdrop raffle against the production
// factory so the new chest-reveal UI (CyolRevealChest) has something real
// to open in the browser afterward, and confirms ClaimAirdropShare actually
// pays out on chain.
const [, , label = "frontenddev8"] = process.argv;

async function main() {
  const { contractAddress: factoryAddress } = JSON.parse(
    readFileSync(path.resolve(__dirname, `../deployment-cyol-factory-${label}.json`), "utf8")
  );
  console.log("Factory:", factoryAddress);

  const creator = loadWallet("ADMIN_MNEMONIC");
  const buyers = [loadWallet("PLAYER1_MNEMONIC"), loadWallet("PLAYER2_MNEMONIC"), loadWallet("PLAYER3_MNEMONIC")];
  console.log("Creator:", creator.address);
  console.log(
    "Buyers:",
    buyers.map((b) => b.address)
  );

  console.log("\nCreating a free, 3-player Airdrop raffle...");
  const createRes = await creator.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: creator.address,
        contract: factoryAddress,
        msg: {
          create_raffle: {
            raffle_type: "airdrop",
            ticket_price: "0",
            ticket_denom: "uluna",
            allowed_entrants: null,
            min_players: 2,
            max_players: 3,
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
  console.log(`Airdrop tier fee: ${config.fee_amount_usdc} ${config.usdc_denom} (max_players=3 tier).`);

  console.log("\nPaying the service fee + depositing a 30.00 prize (10.00 per person once 3 join)...");
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
        funds: [{ denom: "uluna", amount: "30000000" }],
      }),
    ],
  });
  if (depositRes.txResponse.code !== 0) throw new Error(`DepositPrize failed: ${depositRes.txResponse.rawLog}`);
  console.log("Funded and open.");

  console.log("\nBuying 1 free ticket from each of the 3 wallets (Airdrop caps at 1/wallet)...");
  for (const buyer of buyers) {
    const res = await buyer.broadcastTxSync({
      msgs: [new MsgExecuteContract({ sender: buyer.address, contract: raffleAddress, msg: { buy_ticket: {} }, funds: [] })],
    });
    if (res.txResponse.code !== 0) throw new Error(`BuyTicket (${buyer.address}) failed: ${res.txResponse.rawLog}`);
  }
  console.log("3/3 unique players in.");

  // Filling the raffle closes AND draws atomically in the same BuyTicket tx
  // (perform_draw, see the grinding-resistance fix documented in "Repeg
  // Club - Create Your Own Luck (seguridad, hallazgos y exploits)" section
  // 2) - unlike a timeout-close, there's no separate "closed" state to wait
  // through here, DrawWinner never gets called explicitly.
  const status = await queryContract<{ status: string }>(RPC, {
    address: raffleAddress,
    query: { get_raffle_status: {} },
  });
  console.log("Status after 3rd buy:", status.status);
  if (status.status !== "drawn") throw new Error(`Expected status "drawn" (fill-triggers-draw), got "${status.status}"`);

  const share = await queryContract<{ share: string; claimed: boolean }>(RPC, {
    address: raffleAddress,
    query: { get_my_airdrop_share: { wallet: buyers[0].address } },
  });
  console.log(`Buyer 1's share per GetMyAirdropShare: ${share.share} uluna (claimed: ${share.claimed}).`);
  if (share.share !== "10000000") throw new Error(`Expected a 10.00 share (30/3), got ${share.share}`);

  console.log("\nBuyer 1 claims their share...");
  // Checking buyer1's OWN balance delta would be misleading on this testnet:
  // buyer1 pays gas in the same "uluna" stand-in denom as the prize itself
  // (unlike production, where gas is real LUNC and the prize is real USDC -
  // two currencies that never net against each other), so a real payout can
  // still show up as a net-negative balance change once a large-relative-to-
  // the-prize testnet gas fee is subtracted. Check the raffle contract's own
  // balance instead - it's the one actually paying out, unaffected by who
  // covers the claimer's gas.
  const contractBalanceBefore = await ulunaBalance(raffleAddress);
  const claimRes = await buyers[0].broadcastTxSync({
    msgs: [
      new MsgExecuteContract({ sender: buyers[0].address, contract: raffleAddress, msg: { claim_airdrop_share: {} }, funds: [] }),
    ],
  });
  if (claimRes.txResponse.code !== 0) throw new Error(`ClaimAirdropShare failed: ${claimRes.txResponse.rawLog}`);
  const wasmEvent = claimRes.txResponse.events.find((e) => e.type === "wasm");
  const claimedShare = wasmEvent?.attributes.find((a) => a.key === "share")?.value;
  console.log(`ClaimAirdropShare tx ok | share attribute: ${claimedShare} | gasUsed: ${claimRes.txResponse.gasUsed}`);
  if (claimedShare !== "10000000") throw new Error(`Expected the "share" event attribute to be 10000000, got ${claimedShare}`);

  const contractBalanceAfter = await ulunaBalance(raffleAddress);
  const contractDelta = contractBalanceAfter - contractBalanceBefore;
  console.log(`Raffle contract's own balance delta: ${contractDelta} uluna (expected exactly -10000000, the full gross share).`);
  if (contractDelta !== -10000000n) {
    throw new Error(`Expected the contract's balance to drop by exactly 10000000, got a delta of ${contractDelta}.`);
  }

  const shareAfterClaim = await queryContract<{ share: string; claimed: boolean }>(RPC, {
    address: raffleAddress,
    query: { get_my_airdrop_share: { wallet: buyers[0].address } },
  });
  console.log(`Share after claim: ${shareAfterClaim.share} uluna, claimed: ${shareAfterClaim.claimed}`);
  if (!shareAfterClaim.claimed) throw new Error("claimed flag did not flip to true after ClaimAirdropShare");
  console.log("OK: claimed flag flipped, contract balance dropped by exactly the gross share - Airdrop payout confirmed end to end.");

  console.log(`\nAll checks passed. Open in the browser: http://localhost:5173/create-your-own-luck/${raffleAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
