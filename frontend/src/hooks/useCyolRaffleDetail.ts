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
import { getCw20Whitelisted, getCw20Blacklisted } from "../lib/queryFactory";
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
      // Raw one-entry-per-ticket address list (see getEntrants) - exposed so
      // the drawn-state UI can build the reveal wheel's segments without a
      // second, duplicate query.
      entrants: string[];
      // Mirrors execute_cancel_raffle's own
      // cancellation_penalty_waived_by_platform_revocation (round-10 audit
      // fix) - true only for a CW20-prized raffle still Funding with nothing
      // deposited yet, whose token the factory now reports as blacklisted or
      // (paid raffles only) no longer whitelisted. Always false for a native
      // prize - no live query needed, matching the contract's own early
      // return.
      cancellationPenaltyWaivedByPlatformRevocation: boolean;
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
        // Raffles from before GetEntrants existed reject this query - don't
        // let that take down the rest of the page.
        getEntrants(contractAddress).catch(() => ({ entrants: [] as string[] })),
      ]);

      const winners = raffleStatus.status === "drawn" ? await getWinners(contractAddress) : null;
      const myAirdropShare =
        raffleStatus.status === "drawn" && config.raffle_type === "airdrop" && walletAddress
          ? await getMyAirdropShare(contractAddress, walletAddress)
          : null;
      const myTicketCount = walletAddress
        ? entrants.entrants.filter((addr) => addr === walletAddress).length
        : null;

      // Mirrors cancellation_penalty_waived_by_platform_revocation's own
      // early return - only relevant for a CW20-prized raffle still Funding
      // with nothing deposited yet, so this never fires an extra query for
      // the common native-prize case.
      //
      // Round-11 audit fix (Opus): both queries below are caught rather than
      // being allowed to reject into this function's own try/catch - a
      // non-responding factory_address (a direct-instantiate bypass, or any
      // other reason the query fails) used to downgrade the ENTIRE page to
      // the generic error state over what's genuinely just a display hint,
      // hiding the Cancel button the creator actually needs. Same defensive
      // pattern getEntrants already uses a few lines up, for the same
      // reason. Catch defaults are deliberately asymmetric, not just both
      // `false`: blacklisted defaults to not-blacklisted (safe - undercounts
      // toward "no waiver"), but whitelisted defaults to `true` so
      // `!whitelisted` also lands on not-waived - defaulting it to `false`
      // would flip `cancellationPenaltyWaivedByPlatformRevocation` to `true`
      // on a query failure, wrongly telling a creator their cancel is
      // penalty-free when it isn't confirmed either way.
      let cancellationPenaltyWaivedByPlatformRevocation = false;
      const cw20Address = "cw20" in config.prize_asset ? config.prize_asset.cw20.address : null;
      if (cw20Address && raffleStatus.status === "funding" && raffleStatus.prize_amount === "0") {
        const blacklisted = await getCw20Blacklisted(cw20Address, config.factory_address).catch(() => false);
        if (blacklisted) {
          cancellationPenaltyWaivedByPlatformRevocation = true;
        } else if (config.ticket_price !== "0") {
          const whitelisted = await getCw20Whitelisted(cw20Address, config.factory_address).catch(() => true);
          cancellationPenaltyWaivedByPlatformRevocation = !whitelisted;
        }
      }

      if (isCurrent(token)) {
        setState({
          status: "loaded",
          config,
          raffleStatus,
          winners,
          myAirdropShare,
          myTicketCount,
          entrants: entrants.entrants,
          cancellationPenaltyWaivedByPlatformRevocation,
        });
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
