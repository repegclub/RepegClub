import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameNav } from "../Shared/GameNav";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { useWallet } from "../../contexts/WalletContext";
import { useCyolRaffles } from "../../hooks/useCyolRaffles";
import { useCyolRaffleSummaries, type CyolRaffleListEntry } from "../../hooks/useCyolRaffleSummaries";
import type { RaffleRecordResponse } from "../../lib/queryFactory";
import { RaffleCard } from "./RaffleCard";
import { CreatorForm } from "./CreatorForm";

type StatusFilter = "all" | "open" | "funding" | "closed" | "drawn" | "cancelled" | "mine";
const STATUS_FILTERS: StatusFilter[] = ["all", "open", "funding", "closed", "drawn", "cancelled", "mine"];

// A stable reference (not a fresh `[]` literal on every render) - passed to
// useCyolRaffleSummaries while the raffle list itself hasn't loaded yet, so
// its effect doesn't see a "new" array and refire on every render.
const NO_RECORDS: RaffleRecordResponse[] = [];

function matchesFilter(entry: CyolRaffleListEntry, filter: StatusFilter, walletAddress: string | null): boolean {
  if (filter === "all") return true;
  if (filter === "mine") return entry.creator === walletAddress;
  return entry.summary.status === "loaded" && entry.summary.raffleStatus.status === filter;
}

// Step 2: the real discovery page (raffle cards with live status/price, the
// "I'm a creator" form) on top of step 1's proven-working plumbing.
export function CreateYourOwnLuckPage() {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const walletAddress = walletState.status === "connected" ? walletState.wallet.address : null;
  const raffles = useCyolRaffles();
  const { entries, loaded } = useCyolRaffleSummaries(
    raffles.status === "loaded" ? raffles.raffles.raffles : NO_RECORDS
  );
  const [filter, setFilter] = useState<StatusFilter>("all");

  // "Created by me" only means anything with a wallet connected - if it
  // disconnects mid-filter, every entry would compare against null (never
  // matching) and silently show an empty list with no explanation.
  useEffect(() => {
    if (!walletAddress && filter === "mine") setFilter("all");
  }, [walletAddress, filter]);

  const visibleEntries = entries.filter((entry) => matchesFilter(entry, filter, walletAddress));

  return (
    <main className="wheel-page cyol-page">
      <div className="wallet-bar">
        <GameNav current="/create-your-own-luck" />
        <div className="wallet-bar-right">
          <ConnectWalletButton />
        </div>
      </div>

      <h1 className="cyol-title">{t("createYourOwnLuck.pageTitle")}</h1>

      <CreatorForm onCreated={raffles.refetch} />

      <h2 className="cyol-list-title">{t("createYourOwnLuck.raffleListTitle")}</h2>
      {raffles.status === "loading" && <p>{t("createYourOwnLuck.loading")}</p>}
      {raffles.status === "error" && <p>{t("createYourOwnLuck.error")}</p>}
      {raffles.status === "loaded" && raffles.raffles.raffles.length === 0 && (
        <p>{t("createYourOwnLuck.empty")}</p>
      )}
      {raffles.status === "loaded" && raffles.raffles.raffles.length > 0 && (
        <>
          {raffles.raffles.raffles.length < raffles.raffles.total_count && (
            <p className="cyol-partial-note">
              {t("createYourOwnLuck.partialList", {
                shown: raffles.raffles.raffles.length,
                total: raffles.raffles.total_count,
              })}
            </p>
          )}
          <div className="cyol-filter-bar">
            {STATUS_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                className={`cyol-filter-chip${filter === option ? " active" : ""}`}
                disabled={option === "mine" && !walletAddress}
                title={option === "mine" && !walletAddress ? t("createYourOwnLuck.form.connectFirst") : undefined}
                onClick={() => setFilter(option)}
              >
                {option === "all"
                  ? t("createYourOwnLuck.filter.all")
                  : option === "mine"
                    ? t("createYourOwnLuck.filter.mine")
                    : t(`createYourOwnLuck.status.${option}`)}
              </button>
            ))}
          </div>
          {!loaded ? (
            <p>{t("createYourOwnLuck.loading")}</p>
          ) : visibleEntries.length === 0 ? (
            <p>{t("createYourOwnLuck.filter.empty")}</p>
          ) : (
            <div className="cyol-card-grid">
              {visibleEntries.map((entry) => (
                <RaffleCard key={entry.index} address={entry.address} index={entry.index} summary={entry.summary} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
