import { queryContract } from "@goblinhunt/cosmes/client";
import { RPC } from "./chainConfig";

// Mirrors contracts/create-your-own-luck/src/state.rs and msg.rs exactly.
export type CyolRaffleType = "single_winner" | "podium" | "airdrop";
export type CyolRaffleStatus = "funding" | "open" | "closed" | "drawn" | "cancelled";
export type CyolPrizeAsset = { native: { denom: string } } | { cw20: { address: string } };

export type CyolRaffleStatusResponse = {
  status: CyolRaffleStatus;
  raffle_type: CyolRaffleType;
  ticket_count: number;
  unique_player_count: number;
  prize_amount: string;
  prize_asset: CyolPrizeAsset;
  fee_paid: boolean;
  opened_at: number | null;
  closed_at: number | null;
  seconds_remaining: number | null;
  draw_after_height: number | null;
};

export type CyolConfigResponse = {
  creator: string;
  raffle_type: CyolRaffleType;
  ticket_price: string;
  ticket_denom: string;
  allowed_entrants: string[] | null;
  min_players: number;
  max_players: number;
  round_timeout_seconds: number;
  draw_delay_blocks: number;
  draw_window_blocks: number;
  unclaimed_deadline_days: number;
  prize_asset: CyolPrizeAsset;
  fee_amount_usdc: string;
  usdc_denom: string;
  founder_fee_address: string;
  treasury_address: string;
  podium_shares_bps: number[];
};

export function getRaffleStatus(contractAddress: string) {
  return queryContract<CyolRaffleStatusResponse>(RPC, {
    address: contractAddress,
    query: { get_raffle_status: {} },
  });
}

export function getRaffleConfig(contractAddress: string) {
  return queryContract<CyolConfigResponse>(RPC, {
    address: contractAddress,
    query: { get_config: {} },
  });
}
