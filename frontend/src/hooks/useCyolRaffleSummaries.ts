import { useEffect, useState } from "react";
import {
  getRaffleConfig,
  getRaffleStatus,
  getWinners,
  type CyolConfigResponse,
  type CyolRaffleStatusResponse,
  type CyolWinnersResponse,
} from "../lib/queryCyolRaffle";
import type { RaffleRecordResponse } from "../lib/queryFactory";
import { useLatestRequest } from "./useLatestRequest";

export type CyolRaffleSummaryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      config: CyolConfigResponse;
      raffleStatus: CyolRaffleStatusResponse;
      winners: CyolWinnersResponse | null;
    };

export type CyolRaffleListEntry = RaffleRecordResponse & { summary: CyolRaffleSummaryState };

async function loadOneSummary(address: string): Promise<CyolRaffleSummaryState> {
  try {
    const [config, raffleStatus] = await Promise.all([getRaffleConfig(address), getRaffleStatus(address)]);
    // Isolated on purpose: config/raffleStatus already succeeded and are
    // enough to render and filter this raffle - a getWinners hiccup
    // shouldn't blank the whole card out or drop it from the Drawn filter.
    let winners: CyolWinnersResponse | null = null;
    if (raffleStatus.status === "drawn") {
      try {
        winners = await getWinners(address);
      } catch {
        // Card still renders with winners null - just can't show the
        // winner line until this succeeds on a later refetch.
      }
    }
    return { status: "loaded", config, raffleStatus, winners };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Query failed." };
  }
}

// Every card's own type/price/status, fetched up front for the whole list -
// the factory record alone (address/creator/index/created_at) isn't enough
// to filter by status or "created by me", both of which need each raffle's
// own config/status resolved first. One raffle's own query failing doesn't
// blank out the rest (loadOneSummary catches its own errors), same as the
// old per-card hook this replaces.
export function useCyolRaffleSummaries(
  records: RaffleRecordResponse[]
): { entries: CyolRaffleListEntry[]; loaded: boolean } {
  const [entries, setEntries] = useState<CyolRaffleListEntry[]>([]);
  // Distinct from each entry's own "loading" summary status - this is
  // "has the batch resolved at all yet", so callers filtering by status
  // can tell "still fetching everything" apart from "fetched, and none
  // of them actually match" (an empty records list resolves immediately).
  const [loaded, setLoaded] = useState(false);
  const { start, isCurrent } = useLatestRequest();

  useEffect(() => {
    const token = start();
    setLoaded(false);
    setEntries(records.map((r) => ({ ...r, summary: { status: "loading" } })));
    Promise.all(records.map(async (r) => ({ ...r, summary: await loadOneSummary(r.address) }))).then(
      (resolved) => {
        if (isCurrent(token)) {
          setEntries(resolved);
          setLoaded(true);
        }
      }
    );
  }, [records, start, isCurrent]);

  return { entries, loaded };
}
