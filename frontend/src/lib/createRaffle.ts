import { MsgExecuteContract } from "@goblinhunt/cosmes/client";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS } from "./deployment";

// Same fixed memo every other action in this app broadcasts with - see
// roundActions.ts.
const MEMO = "REPEG CLUB";

// Fields the creator doesn't choose - fixed to the exact production values
// already used platform-wide (Wheel Manager/Weekly Round's own redeploys):
// draw_window_blocks comfortably covers a keeper crash/restart before the
// draw window would need to auto-rearm; unclaimed_deadline_days matches the
// platform's standard unclaimed-prize sweep window everywhere else;
// max_raffle_age_seconds matches Wheel Manager's max_round_age_seconds
// (48h) - same "pure housekeeping" backstop for a raffle stuck below
// min_players with an unresponsive creator, see ExpireRaffle.
const ROUND_TIMEOUT_SECONDS = 3600;
const DRAW_DELAY_BLOCKS = 2;
const DRAW_WINDOW_BLOCKS = 60;
const UNCLAIMED_DEADLINE_DAYS = 90;
const MAX_RAFFLE_AGE_SECONDS = 172800;

export type CreateRaffleParams = {
  raffleType: "single_winner" | "podium" | "airdrop";
  ticketPriceAmount: string; // micro units
  ticketDenom: string;
  minPlayers: number;
  maxPlayers: number;
  prizeNativeDenom: string;
  // Required (summing to 10000) for Podium, empty otherwise - see
  // contracts/create-your-own-luck/src/msg.rs.
  podiumSharesBps: number[];
  // Gates BuyTicket to these addresses only when set (any raffle type, not
  // just Airdrop) - contracts/create-your-own-luck/src/execute.rs.
  allowedEntrants: string[] | null;
};

export async function createRaffle(wallet: ConnectedWallet, params: CreateRaffleParams) {
  const res = await wallet.broadcastTxSync({
    msgs: [
      new MsgExecuteContract({
        sender: wallet.address,
        contract: CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS,
        msg: {
          create_raffle: {
            raffle_type: params.raffleType,
            ticket_price: params.ticketPriceAmount,
            ticket_denom: params.ticketDenom,
            allowed_entrants: params.allowedEntrants,
            min_players: params.minPlayers,
            max_players: params.maxPlayers,
            round_timeout_seconds: ROUND_TIMEOUT_SECONDS,
            draw_delay_blocks: DRAW_DELAY_BLOCKS,
            draw_window_blocks: DRAW_WINDOW_BLOCKS,
            unclaimed_deadline_days: UNCLAIMED_DEADLINE_DAYS,
            max_raffle_age_seconds: MAX_RAFFLE_AGE_SECONDS,
            prize_native_denom: params.prizeNativeDenom,
            prize_cw20_address: null,
            podium_shares_bps: params.podiumSharesBps,
          },
        },
        funds: [],
      }),
    ],
    memo: MEMO,
  });
  if (res.txResponse.code !== 0) {
    throw new Error(res.txResponse.rawLog || "Transaction failed.");
  }

  // Same event-parsing pattern as scripts/testnet/src/checkFactoryCreateRaffle.ts.
  const instantiateEvent = res.txResponse.events.find((e) => e.type === "instantiate");
  const raffleAddress = instantiateEvent?.attributes.find((a) => a.key === "_contract_address")?.value;

  return { res, raffleAddress };
}
