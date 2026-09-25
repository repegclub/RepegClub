import { useCallback, useEffect, useState } from "react";
import { getRaffles } from "../lib/queryFactory";
import { getRaffleStatus } from "../lib/queryCyolRaffle";
import { useLatestRequest } from "./useLatestRequest";

export type CyolCounts = {
  liveRaffles: number;
  liveAirdrops: number;
  createdRaffles: number;
  createdAirdrops: number;
  totalCreated: number;
  // False when the raffle/airdrop split can't be trusted: more raffles exist
  // than one factory page returns, or some raffle's own status query failed.
  // The landing then shows totalCreated alone instead of a wrong split.
  splitComplete: boolean;
};

export type CyolCountsState = { status: "loading" } | { status: "error" } | { status: "loaded"; counts: CyolCounts };

// The factory's own max page size (see create-your-own-luck-factory's
// query.rs) - newest-first, so anything still live is always in here.
const PAGE_LIMIT = 100;

// Landing-page teaser counts for Create Your Own Luck. Only needs each
// raffle's status (which already carries raffle_type), not its full config
// like useCyolRaffleSummaries does for the list page.
export function useCyolCounts(): CyolCountsState {
  const [state, setState] = useState<CyolCountsState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(async () => {
    const token = start();
    try {
      const { raffles, total_count } = await getRaffles(undefined, PAGE_LIMIT);
      const results = await Promise.allSettled(raffles.map((r) => getRaffleStatus(r.address)));
      const counts: CyolCounts = {
        liveRaffles: 0,
        liveAirdrops: 0,
        createdRaffles: 0,
        createdAirdrops: 0,
        totalCreated: total_count,
        splitComplete: raffles.length === total_count,
      };
      for (const result of results) {
        if (result.status === "rejected") {
          counts.splitComplete = false;
          continue;
        }
        const isAirdrop = result.value.raffle_type === "airdrop";
        if (isAirdrop) counts.createdAirdrops++;
        else counts.createdRaffles++;
        if (result.value.status === "open") {
          if (isAirdrop) counts.liveAirdrops++;
          else counts.liveRaffles++;
        }
      }
      if (isCurrent(token)) setState({ status: "loaded", counts });
    } catch {
      if (isCurrent(token)) setState({ status: "error" });
    }
  }, [start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return state;
}
