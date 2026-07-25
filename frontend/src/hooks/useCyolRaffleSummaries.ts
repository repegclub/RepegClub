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
    const winners = raffleStatus.status === "drawn" ? await getWinners(address) : null;
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
export function useCyolRaffleSummaries(records: RaffleRecordResponse[]): CyolRaffleListEntry[] {
  const [entries, setEntries] = useState<CyolRaffleListEntry[]>([]);
  const { start, isCurrent } = useLatestRequest();

  useEffect(() => {
    const token = start();
    setEntries(records.map((r) => ({ ...r, summary: { status: "loading" } })));
    Promise.all(records.map(async (r) => ({ ...r, summary: await loadOneSummary(r.address) }))).then(
      (resolved) => {
        if (isCurrent(token)) setEntries(resolved);
      }
    );
  }, [records, start, isCurrent]);

  return entries;
}
