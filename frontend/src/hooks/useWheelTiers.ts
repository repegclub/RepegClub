import { useCallback, useEffect, useState } from "react";
import { getConfig, getCurrentRound, getRoundEntrants } from "../lib/queryWheelManager";
import { WHEEL_MANAGER_ADDRESSES } from "../lib/deployment";

export type TierInfo = {
  address: string;
  ticketPrice: string;
  ticketDenom: string;
  currentRoundId: number;
  // How many tickets the connected wallet holds in THIS tier's current
  // (still-open-or-closed, not-yet-resolved) round - 0 if disconnected or
  // the wallet just hasn't bought in here.
  myTicketCount: number;
};

export type WheelTiersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; tiers: TierInfo[] };

async function loadTier(address: string, wallet: string | null): Promise<TierInfo> {
  const [config, round] = await Promise.all([getConfig(address), getCurrentRound(address)]);
  let myTicketCount = 0;
  if (wallet) {
    const entrants = await getRoundEntrants(round.round_id, address);
    myTicketCount = entrants.entrants.filter((a) => a === wallet).length;
  }
  return {
    address,
    ticketPrice: config.ticket_price,
    ticketDenom: config.ticket_denom,
    currentRoundId: round.round_id,
    myTicketCount,
  };
}

// Among tiers where the wallet already holds a ticket, the most expensive
// one wins (that's presumably the game they care most about right now);
// with no active ticket anywhere, default to the cheapest tier - the
// natural entry point for someone new.
export function pickDefaultTierAddress(tiers: TierInfo[]): string | null {
  if (tiers.length === 0) return null;
  const withTickets = tiers.filter((t) => t.myTicketCount > 0);
  if (withTickets.length > 0) {
    return withTickets.reduce((best, t) => (BigInt(t.ticketPrice) > BigInt(best.ticketPrice) ? t : best))
      .address;
  }
  return tiers.reduce((best, t) => (BigInt(t.ticketPrice) < BigInt(best.ticketPrice) ? t : best)).address;
}

export function useWheelTiers(wallet: string | null): WheelTiersState & { refetch: () => void } {
  const [state, setState] = useState<WheelTiersState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    Promise.all(WHEEL_MANAGER_ADDRESSES.map((address) => loadTier(address, wallet)))
      .then((tiers) => setState({ status: "loaded", tiers }))
      .catch((err) =>
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        })
      );
  }, [wallet]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
