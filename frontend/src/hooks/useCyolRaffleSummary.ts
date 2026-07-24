import { useCallback, useEffect, useState } from "react";
import {
  getRaffleConfig,
  getRaffleStatus,
  getWinners,
  type CyolConfigResponse,
  type CyolRaffleStatusResponse,
  type CyolWinnersResponse,
} from "../lib/queryCyolRaffle";
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

// One raffle card's own data - the factory only stores address/creator/
// timestamp (see queryFactory.ts), so each card queries its raffle contract
// directly for the type/price/status that's actually useful to show. Winners
// are only fetched once the raffle is actually Drawn (so any card in the
// list - not just the raffle's own detail page - can show who won and let
// anyone verify the payout, per the user's explicit request 2026-07-23).
export function useCyolRaffleSummary(contractAddress: string): CyolRaffleSummaryState {
  const [state, setState] = useState<CyolRaffleSummaryState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(async () => {
    const token = start();
    try {
      const [config, raffleStatus] = await Promise.all([
        getRaffleConfig(contractAddress),
        getRaffleStatus(contractAddress),
      ]);
      const winners = raffleStatus.status === "drawn" ? await getWinners(contractAddress) : null;
      if (isCurrent(token)) setState({ status: "loaded", config, raffleStatus, winners });
    } catch (err) {
      if (isCurrent(token)) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        });
      }
    }
  }, [contractAddress, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return state;
}
