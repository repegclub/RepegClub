import { useCallback, useEffect, useState } from "react";
import {
  getRaffleConfig,
  getRaffleStatus,
  type CyolConfigResponse,
  type CyolRaffleStatusResponse,
} from "../lib/queryCyolRaffle";
import { useLatestRequest } from "./useLatestRequest";

export type CyolRaffleSummaryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; config: CyolConfigResponse; raffleStatus: CyolRaffleStatusResponse };

// One raffle card's own data - the factory only stores address/creator/
// timestamp (see queryFactory.ts), so each card queries its raffle contract
// directly for the type/price/status that's actually useful to show.
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
      if (isCurrent(token)) setState({ status: "loaded", config, raffleStatus });
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
