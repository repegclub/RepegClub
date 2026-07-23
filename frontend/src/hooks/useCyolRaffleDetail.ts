import { useCallback, useEffect, useState } from "react";
import {
  getRaffleConfig,
  getRaffleStatus,
  getWinners,
  getMyAirdropShare,
  getEntrants,
  type CyolConfigResponse,
  type CyolRaffleStatusResponse,
  type CyolWinnersResponse,
  type CyolMyAirdropShareResponse,
} from "../lib/queryCyolRaffle";
import { useLatestRequest } from "./useLatestRequest";

export type CyolRaffleDetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      config: CyolConfigResponse;
      raffleStatus: CyolRaffleStatusResponse;
      winners: CyolWinnersResponse | null;
      myAirdropShare: CyolMyAirdropShareResponse | null;
      // A wallet's own ticket count in this raffle, computed from the full
      // entrants list (no dedicated per-wallet query exists) - null when no
      // wallet is connected.
      myTicketCount: number | null;
    };

// Everything one raffle's own page needs, in one hook - winners and "my
// airdrop share" are only fetched once the raffle is actually Drawn (the
// queries return meaningless/zero data before that anyway). walletAddress
// drives myAirdropShare, so it's a dependency here the same way the round/
// tier params are for the other 6 data hooks (see useLatestRequest) - a
// wallet switch mid-flight must not let a stale response for the old wallet
// land after a newer one for the new wallet.
export function useCyolRaffleDetail(
  contractAddress: string,
  walletAddress: string | null
): CyolRaffleDetailState & { refetch: () => void } {
  const [state, setState] = useState<CyolRaffleDetailState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(async () => {
    const token = start();
    try {
      const [config, raffleStatus, entrants] = await Promise.all([
        getRaffleConfig(contractAddress),
        getRaffleStatus(contractAddress),
        getEntrants(contractAddress),
      ]);

      const winners = raffleStatus.status === "drawn" ? await getWinners(contractAddress) : null;
      const myAirdropShare =
        raffleStatus.status === "drawn" && config.raffle_type === "airdrop" && walletAddress
          ? await getMyAirdropShare(contractAddress, walletAddress)
          : null;
      const myTicketCount = walletAddress
        ? entrants.entrants.filter((addr) => addr === walletAddress).length
        : null;

      if (isCurrent(token)) {
        setState({ status: "loaded", config, raffleStatus, winners, myAirdropShare, myTicketCount });
      }
    } catch (err) {
      if (isCurrent(token)) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Query failed.",
        });
      }
    }
  }, [contractAddress, walletAddress, start, isCurrent]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refetch: load };
}
