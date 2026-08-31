import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameNav } from "../Shared/GameNav";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { NetworkBadge } from "../Wallet/NetworkBadge";
import { WalletBalance } from "../Wallet/WalletBalance";
import { useWallet } from "../../contexts/WalletContext";
import { useCyolRaffles } from "../../hooks/useCyolRaffles";
import { useCyolRaffleSummaries, type CyolRaffleListEntry } from "../../hooks/useCyolRaffleSummaries";
import type { RaffleRecordResponse } from "../../lib/queryFactory";
import { RaffleCard } from "./RaffleCard";

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

// Collapsible so 2 lists together don't turn this page into endless scroll
// once either has more than a handful of entries (direct request,
// 2026-08-20) - same toggle pattern as CreatorForm.tsx's own sections.
// Defaults open (nothing changes for a first-time visitor); collapsing is
// purely a "get this out of my way" action.
function CyolListSection({
  titleKey,
  emptyKey,
  entries,
  open,
  onToggle,
}: {
  titleKey: string;
  emptyKey: string;
  entries: CyolRaffleListEntry[];
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" className="cyol-list-toggle" onClick={onToggle}>
        {t(titleKey)} {open ? "▲" : "▼"}
      </button>
      {open &&
        (entries.length === 0 ? (
          <p>{t(emptyKey)}</p>
        ) : (
          <div className="cyol-card-grid">
            {entries.map((entry) => (
              <RaffleCard key={entry.index} address={entry.address} index={entry.index} summary={entry.summary} />
            ))}
          </div>
        ))}
    </>
  );
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
  // GameNav's "Airdrops" entry links here with ?view=airdrops so it lands
  // with that section open and Raffles collapsed instead of today's default
  // (both open).
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const [rafflesOpen, setRafflesOpen] = useState(view !== "airdrops");
  const [airdropsOpen, setAirdropsOpen] = useState(true);

  // Both links here are client-side <Link> navigations to the same route
  // (only the query string changes), so react-router never remounts this
  // component - the useState initializer above only ran once, at first
  // mount, and never saw a later click from Raffles to Airdrops or back
  // (CodeRabbit finding, 2026-08-31). Keyed on `view` specifically (not the
  // whole `searchParams` object, a fresh reference every render) so this
  // only re-fires when that value actually changes, not on every render -
  // still lets the toggle buttons below freely open/close either section
  // in between.
  useEffect(() => {
    setRafflesOpen(view !== "airdrops");
  }, [view]);

  // "Created by me" only means anything with a wallet connected - if it
  // disconnects mid-filter, every entry would compare against null (never
  // matching) and silently show an empty list with no explanation.
  useEffect(() => {
    if (!walletAddress && filter === "mine") setFilter("all");
  }, [walletAddress, filter]);

  const visibleEntries = entries.filter((entry) => matchesFilter(entry, filter, walletAddress));
  // Split into 2 lists instead of 1 mixed "Active raffles" grid (direct
  // request, 2026-08-20) - same "Airdrop isn't a raffle" principle already
  // applied to the creator forms (CreatorForm.tsx's `mode`). By the time
  // this runs `loaded` is already true, so every entry's summary has
  // settled to "loaded" or "error" (see useCyolRaffleSummaries.ts) - never
  // "loading" - an entry whose query failed has no known raffle_type, so it
  // falls into the raffles bucket by default rather than being silently
  // dropped from both.
  const airdropEntries = visibleEntries.filter(
    (entry) => entry.summary.status === "loaded" && entry.summary.config.raffle_type === "airdrop"
  );
  const raffleEntries = visibleEntries.filter((entry) => !airdropEntries.includes(entry));

  return (
    <main className="wheel-page cyol-page">
      <div className="wallet-bar">
        <GameNav current="/create-your-own-luck" />
        <div className="wallet-bar-right">
          <div className="wallet-status-group">
            <NetworkBadge />
            <ConnectWalletButton />
          </div>
          {/* Wallet balance, not game data - belongs on every page, same as
              Wheel of Repeg/Weekly Round (see .wallet-bar-secondary there).
              CYOL had no History button to pair it with, same as Weekly
              Round, so it wraps to its own line alone at real phone widths
              same as WalletBalance already does there. */}
          <div className="wallet-bar-secondary">
            <WalletBalance />
          </div>
        </div>
      </div>

      <h1 className="cyol-title">{t("createYourOwnLuck.pageTitle")}</h1>

      {/* "Galactic Raffle" booth art (2026-08-20, direct request) - same
          alien-carnival lore the rest of the site already leans on, now
          naming this product too ("Galactic Raffles"). Plain framed banner,
          not a screen-text overlay like the onramp/treasury banners - this
          scene already has its own signage baked in, nothing to print on
          top of it. */}
      <div className="cyol-page-banner-border panel-border pixel-stepped-corners">
        <div className="panel-highlight pixel-stepped-corners">
          <img src="/characters/galactic-raffle-banner.jpg" alt="" className="cyol-page-banner pixel-stepped-corners" />
        </div>
      </div>

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
            <>
              <CyolListSection
                titleKey="createYourOwnLuck.raffleListTitle"
                emptyKey="createYourOwnLuck.filter.emptyRaffle"
                entries={raffleEntries}
                open={rafflesOpen}
                onToggle={() => setRafflesOpen((o) => !o)}
              />
              <CyolListSection
                titleKey="createYourOwnLuck.airdropListTitle"
                emptyKey="createYourOwnLuck.filter.emptyAirdrop"
                entries={airdropEntries}
                open={airdropsOpen}
                onToggle={() => setAirdropsOpen((o) => !o)}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
