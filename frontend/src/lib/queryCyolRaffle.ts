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
  draw_height: number | null;
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
  factory_address: string;
  podium_shares_bps: number[];
  cancellation_penalty_base_bps: number;
  cancellation_penalty_late_additional_bps: number;
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

export type CyolWinnersResponse = {
  winners: string[];
  prize_shares: string[];
  prize_paid: boolean[];
};

export function getWinners(contractAddress: string) {
  return queryContract<CyolWinnersResponse>(RPC, {
    address: contractAddress,
    query: { get_winners: {} },
  });
}

export type CyolMyAirdropShareResponse = {
  share: string;
  claimed: boolean;
};

export function getMyAirdropShare(contractAddress: string, wallet: string) {
  return queryContract<CyolMyAirdropShareResponse>(RPC, {
    address: contractAddress,
    query: { get_my_airdrop_share: { wallet } },
  });
}

export type CyolEntrantsResponse = {
  entrants: string[];
};

// One entry per ticket, duplicates for a wallet holding more than one - same
// shape as Wheel Manager's GetRoundEntrants. No dedicated per-wallet count
// query exists, so the frontend groups this list itself.
export function getEntrants(contractAddress: string) {
  return queryContract<CyolEntrantsResponse>(RPC, {
    address: contractAddress,
    query: { get_entrants: {} },
  });
}
