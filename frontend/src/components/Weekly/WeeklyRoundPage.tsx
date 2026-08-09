import { useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/weekly.css";
import { WeeklyHeroSign } from "./WeeklyHeroSign";
import { WeeklyPoolBanner } from "./WeeklyPoolBanner";
import { WeeklyWheelCard } from "./WeeklyWheelCard";
import { MyWeeklyWinningsPanel } from "./MyWeeklyWinningsPanel";
import { EntrantsPanel } from "../Wheel/EntrantsPanel";
import { FeedbackSection } from "../Shared/FeedbackSection";
import { WeeklyFAQSection } from "./WeeklyFAQSection";
import { LifetimeStatsPanel } from "../Wheel/LifetimeStatsPanel";
import { PlatformRepeggedBanner } from "../Wheel/PlatformRepeggedBanner";
import { GameNav } from "../Shared/GameNav";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { NetworkBadge } from "../Wallet/NetworkBadge";
import { WalletBalance } from "../Wallet/WalletBalance";
import { HistoryButton } from "../Wheel/HistoryButton";
import { AdminSweepButton } from "../Wallet/AdminSweepButton";
import { useWallet } from "../../contexts/WalletContext";
import { useWeeklyRound } from "../../hooks/useWeeklyRound";
import { useWeeklyEntrants } from "../../hooks/useWeeklyEntrants";
import { useLifetimeStats } from "../../hooks/useLifetimeStats";
import { usePlatformRepegged } from "../../hooks/usePlatformRepegged";
import { WEEKLY_ROUND_ADDRESS } from "../../lib/deployment";
import { computeAvailableTickets, maxTicketsPerWallet } from "../../lib/ticketAvailability";
import { formatUluna } from "../../lib/format";
import { buyWeeklyTickets } from "../../lib/roundActions";
import { TicketBooth } from "../Wheel/TicketBooth";

export function WeeklyRoundPage() {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;

  const [viewWeekId, setViewWeekId] = useState<number | undefined>(undefined);
  const weekState = useWeeklyRound(viewWeekId);
  const weekId = weekState.status === "loaded" ? weekState.week.week_id : null;
  const entrantsState = useWeeklyEntrants(weekId);
  const entrants = entrantsState.status === "loaded" ? entrantsState.entrants : [];
  const lifetimeStats = useLifetimeStats(address);
  const platformRepegged = usePlatformRepegged();

  const [purchaseVersion, setPurchaseVersion] = useState(0);
  function handlePurchased() {
    weekState.refetch();
    entrantsState.refetch();
    lifetimeStats.refetch();
    setPurchaseVersion((v) => v + 1);
  }

  const [revealVersion, setRevealVersion] = useState(0);
  function handleRevealed() {
    setRevealVersion((v) => v + 1);
  }

  function handleRedeemed() {
    weekState.refetch();
    lifetimeStats.refetch();
    platformRepegged.refetch();
  }

  function handleWithdrawn() {
    lifetimeStats.refetch();
  }

  const availableTickets =
    weekState.status === "loaded" && weekState.week.status === "open"
      ? computeAvailableTickets(entrants, weekState.config.max_players, address)
      : null;
  const ticketCap =
    weekState.status === "loaded" ? maxTicketsPerWallet(weekState.config.max_players) : undefined;
  // Same fixed sellable ceiling as Wheel of Repeg's own (see
  // WheelOfRepeg.tsx) - no entrants/wallet so it's the theoretical max from
  // a fresh week, not this week's live remaining count.
  const maxTicketsPerRound =
    weekState.status === "loaded" ? computeAvailableTickets([], weekState.config.max_players, null) : undefined;
  const todayPriceDisplay =
    weekState.status === "loaded" ? formatUluna(weekState.week.today_price, "USDC") : t("wheel.loading");

  return (
    <main className="weekly-page">
      <div className="wallet-bar">
        <GameNav current="/weekly-round" />
        <div className="wallet-bar-right">
          <div className="wallet-status-group">
            <NetworkBadge />
            <ConnectWalletButton />
          </div>
          {/* Same .wallet-bar-secondary treatment as Wheel of Repeg's own
              wallet-bar, for consistency. History is account-level, not
              scoped to whichever game's page is open (useWalletHistory
              already combines every Wheel Manager tier + Weekly Round) -
              tiers={[]} since this page has no Wheel Manager tier data of
              its own; HistoryButton falls back to a generic "Wheel of
              Repeg" label for those entries instead of an exact price. */}
          <div className="wallet-bar-secondary">
            <WalletBalance />
            <HistoryButton tiers={[]} />
          </div>
          <AdminSweepButton
            adminAddress={weekState.status === "loaded" ? weekState.config.admin : undefined}
            contractAddress={WEEKLY_ROUND_ADDRESS}
            redemptionDenom={weekState.status === "loaded" ? weekState.config.redemption_denom : undefined}
          />
        </div>
      </div>

      <WeeklyHeroSign />

      <div className="stats-lead-row">
        <PlatformRepeggedBanner stats={platformRepegged} />
        {weekState.status === "loaded" && (
          <WeeklyPoolBanner
            ticketSalesPool={weekState.week.ticket_sales_pool}
            wheelContributions={weekState.week.wheel_contributions}
            pool={weekState.week.pool}
          />
        )}
      </div>

      {/* .weekly-cabinet is a named-areas grid mirroring Wheel of Repeg's own
          .wheel-cabinet exactly (see weekly.css) - replaces the old .stage
          3-column grid, which could only reorder its exactly-3 direct
          children as whole blocks and couldn't interleave the ticket booth
          between the header and the wheel at narrow widths (reported live:
          the booth was landing below the whole prize+wheel+actions column
          instead). WeeklyWheelCard.tsx's 3 pieces (header/wheel/actions)
          are now direct grid items here too, not nested inside one wrapper. */}
      <div className="weekly-cabinet">
        <div className="weekly-cabinet-booth">
          <TicketBooth
            priceDisplay={todayPriceDisplay}
            ticketDenom={weekState.status === "loaded" ? weekState.config.ticket_denom : undefined}
            ticketPriceAmount={weekState.status === "loaded" ? weekState.week.today_price : undefined}
            contractAddress={WEEKLY_ROUND_ADDRESS}
            availableTickets={availableTickets}
            ticketCap={ticketCap}
            maxTicketsPerRound={maxTicketsPerRound}
            onPurchased={handlePurchased}
            buyAction={buyWeeklyTickets}
          />
        </div>

        <WeeklyWheelCard
          key={weekState.status === "loaded" ? weekState.week.week_id : "loading"}
          weekState={weekState}
          entrants={entrants}
          contractAddress={WEEKLY_ROUND_ADDRESS}
          purchaseVersion={purchaseVersion}
          onWeekFinished={setViewWeekId}
          onContinue={() => setViewWeekId(undefined)}
          onEntrantsChanged={entrantsState.refetch}
          onRedeemed={handleRedeemed}
          onWithdrawn={handleWithdrawn}
          onRevealed={handleRevealed}
          onViewWeek={setViewWeekId}
        />

        <div className="weekly-cabinet-participants">
          <EntrantsPanel entrants={entrants} />
          {weekState.status === "loaded" && (
            <MyWeeklyWinningsPanel
              redemptionDenom={weekState.config.redemption_denom}
              unclaimedDeadlineDays={weekState.config.unclaimed_deadline_days}
              contractAddress={WEEKLY_ROUND_ADDRESS}
              onRedeemed={handleRedeemed}
              revealVersion={revealVersion}
              currentWeekId={weekId}
            />
          )}
          <LifetimeStatsPanel stats={lifetimeStats} />
        </div>
      </div>

      <FeedbackSection />
      <WeeklyFAQSection />
    </main>
  );
}
