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
import { LifetimeStatsPanel } from "../Wheel/LifetimeStatsPanel";
import { GameNav } from "../Shared/GameNav";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { WalletBalance } from "../Wallet/WalletBalance";
import { AdminSweepButton } from "../Wallet/AdminSweepButton";
import { useWallet } from "../../contexts/WalletContext";
import { useWeeklyRound } from "../../hooks/useWeeklyRound";
import { useWeeklyEntrants } from "../../hooks/useWeeklyEntrants";
import { useLifetimeStats } from "../../hooks/useLifetimeStats";
import { WEEKLY_ROUND_ADDRESS } from "../../lib/deployment";
import { computeAvailableTickets, maxTicketsPerWallet } from "../../lib/ticketAvailability";
import { formatUluna } from "../../lib/format";
import { buyWeeklyTicket } from "../../lib/roundActions";
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
  const todayPriceDisplay =
    weekState.status === "loaded" ? formatUluna(weekState.week.today_price, "USDC") : t("wheel.loading");

  return (
    <main className="weekly-page">
      <div className="wallet-bar">
        <GameNav current="/weekly-round" />
        <div className="wallet-bar-right">
          <ConnectWalletButton />
          <WalletBalance />
          <AdminSweepButton
            adminAddress={weekState.status === "loaded" ? weekState.config.admin : undefined}
            contractAddress={WEEKLY_ROUND_ADDRESS}
            redemptionDenom={weekState.status === "loaded" ? weekState.config.redemption_denom : undefined}
          />
        </div>
      </div>

      <WeeklyHeroSign />

      {weekState.status === "loaded" && (
        <WeeklyPoolBanner
          ticketSalesPool={weekState.week.ticket_sales_pool}
          wheelContributions={weekState.week.wheel_contributions}
          pool={weekState.week.pool}
        />
      )}

      <div className="stage">
        <div className="stage-left">
          <TicketBooth
            priceDisplay={todayPriceDisplay}
            ticketDenom={weekState.status === "loaded" ? weekState.config.ticket_denom : undefined}
            ticketPriceAmount={weekState.status === "loaded" ? weekState.week.today_price : undefined}
            contractAddress={WEEKLY_ROUND_ADDRESS}
            availableTickets={availableTickets}
            ticketCap={ticketCap}
            onPurchased={handlePurchased}
            buyAction={buyWeeklyTicket}
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

        <div className="stage-right">
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
    </main>
  );
}
