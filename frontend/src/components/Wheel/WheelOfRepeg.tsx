import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import { HeroSign } from "./HeroSign";
import { TierTabs } from "./TierTabs";
import { OtherTicketsList } from "./OtherTicketsList";
import { TicketBooth } from "./TicketBooth";
import { WheelCard } from "./WheelCard";
import { EntrantsPanel } from "./EntrantsPanel";
import { FAQSection } from "./FAQSection";
import { MyWinningsPanel } from "./MyWinningsPanel";
import { LifetimeStatsPanel } from "./LifetimeStatsPanel";
import { HistoryButton } from "./HistoryButton";
import { FeedbackButton } from "./FeedbackButton";
import { PlatformRepeggedBanner } from "./PlatformRepeggedBanner";
import { GameSwitcher } from "../Shared/GameSwitcher";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { WalletBalance } from "../Wallet/WalletBalance";
import { AdminSweepButton } from "../Wallet/AdminSweepButton";
import { ExpiredPrizesButton } from "../Wallet/ExpiredPrizesButton";
import { useWallet } from "../../contexts/WalletContext";
import { useWheelRound } from "../../hooks/useWheelRound";
import { useRoundEntrants } from "../../hooks/useRoundEntrants";
import { useLifetimeStats } from "../../hooks/useLifetimeStats";
import { usePlatformRepegged } from "../../hooks/usePlatformRepegged";
import { useWheelTiers, pickDefaultTierAddress } from "../../hooks/useWheelTiers";
import { formatUluna } from "../../lib/format";
import { computeAvailableTickets, maxTicketsPerWallet } from "../../lib/ticketAvailability";

export function WheelOfRepeg() {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const lifetimeStats = useLifetimeStats(address);
  const platformRepegged = usePlatformRepegged();
  const tiersState = useWheelTiers(address);

  function handleRedeemed() {
    lifetimeStats.refetch();
    platformRepegged.refetch();
    tiersState.refetch();
  }

  // Which tier's wheel is showing. Null until the tiers load, at which
  // point it's set to the default pick (most expensive tier the wallet has
  // an active ticket in, else the cheapest) - see pickDefaultTierAddress.
  // Once a wallet manually picks a tab, that choice sticks even if the
  // underlying tier data refetches.
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  useEffect(() => {
    if (selectedTier !== null || tiersState.status !== "loaded") return;
    setSelectedTier(pickDefaultTierAddress(tiersState.tiers));
  }, [selectedTier, tiersState]);

  function handleSelectTier(tierAddress: string) {
    setSelectedTier(tierAddress);
    setViewRoundId(undefined);
  }

  // Undefined = follow whatever the contract reports as the current round.
  // Pinned to a specific round_id right after DrawWinner, since that tx
  // immediately advances the contract's own "current round" to a fresh one
  // - without pinning, the just-decided round's result would be impossible
  // to keep looking at.
  const [viewRoundId, setViewRoundId] = useState<number | undefined>(undefined);
  const roundState = useWheelRound(viewRoundId, selectedTier ?? undefined);
  const roundId = roundState.status === "loaded" ? roundState.round.round_id : null;
  const entrantsState = useRoundEntrants(roundId, selectedTier ?? undefined);
  const entrants = entrantsState.status === "loaded" ? entrantsState.entrants : [];

  const ticketPriceDisplay =
    roundState.status === "loaded"
      ? formatUluna(roundState.config.ticket_price, "USDC")
      : t("wheel.loading");

  // WheelCard has no other way to know a fresh purchase just happened (that
  // action lives in the sibling TicketBooth) - without this, its "just
  // withdrew" note stays stuck on screen after withdrawing then buying a
  // new ticket in the same still-open round, instead of showing the
  // (now-relevant-again) withdraw button.
  const [purchaseVersion, setPurchaseVersion] = useState(0);

  function handlePurchased() {
    roundState.refetch();
    entrantsState.refetch();
    lifetimeStats.refetch();
    tiersState.refetch();
    setPurchaseVersion((v) => v + 1);
  }

  function handleWithdrawn() {
    lifetimeStats.refetch();
    tiersState.refetch();
  }

  // MyWinningsPanel reads localStorage directly (see revealCache) and has
  // no other way to notice a reveal that just happened in WheelCard - this
  // just needs to change to force it to re-render and re-check.
  const [revealVersion, setRevealVersion] = useState(0);
  function handleRevealed() {
    setRevealVersion((v) => v + 1);
  }

  const tiers = tiersState.status === "loaded" ? tiersState.tiers : [];

  const availableTickets =
    roundState.status === "loaded" && roundState.round.status === "open"
      ? computeAvailableTickets(entrants, roundState.config.max_players, address)
      : null;
  const ticketCap =
    roundState.status === "loaded" ? maxTicketsPerWallet(roundState.config.max_players) : undefined;

  return (
    <main>
      <div className="wallet-bar">
        <ConnectWalletButton />
        <WalletBalance denom={roundState.status === "loaded" ? roundState.config.redemption_denom : undefined} />
        <HistoryButton tiers={tiers} />
        <FeedbackButton />
        <AdminSweepButton
          adminAddress={roundState.status === "loaded" ? roundState.config.admin : undefined}
          contractAddress={selectedTier ?? undefined}
          redemptionDenom={roundState.status === "loaded" ? roundState.config.redemption_denom : undefined}
        />
        <ExpiredPrizesButton
          adminAddress={roundState.status === "loaded" ? roundState.config.admin : undefined}
          tiers={tiers}
        />
      </div>

      <HeroSign />

      <GameSwitcher current="/" />

      <PlatformRepeggedBanner stats={platformRepegged} />

      <p className="lead">{t("lead")}</p>

      <TierTabs tiers={tiers} selectedAddress={selectedTier ?? ""} onSelect={handleSelectTier} />

      <div className="stage">
        <div className="stage-left">
          <TicketBooth
            priceDisplay={ticketPriceDisplay}
            ticketDenom={roundState.status === "loaded" ? roundState.config.ticket_denom : undefined}
            ticketPriceAmount={roundState.status === "loaded" ? roundState.config.ticket_price : undefined}
            contractAddress={selectedTier ?? undefined}
            availableTickets={availableTickets}
            ticketCap={ticketCap}
            onPurchased={handlePurchased}
          />
          <OtherTicketsList tiers={tiers} selectedAddress={selectedTier ?? ""} onSelect={handleSelectTier} />
        </div>

        <WheelCard
          key={selectedTier ?? "loading"}
          roundState={roundState}
          entrants={entrants}
          contractAddress={selectedTier ?? undefined}
          purchaseVersion={purchaseVersion}
          onRoundFinished={setViewRoundId}
          onContinue={() => setViewRoundId(undefined)}
          onEntrantsChanged={entrantsState.refetch}
          onRedeemed={handleRedeemed}
          onWithdrawn={handleWithdrawn}
          onRevealed={handleRevealed}
          onViewRound={setViewRoundId}
        />

        <div className="stage-right">
          <EntrantsPanel entrants={entrants} />
          {roundState.status === "loaded" && (
            <MyWinningsPanel
              redemptionDenom={roundState.config.redemption_denom}
              unclaimedDeadlineDays={roundState.config.unclaimed_deadline_days}
              contractAddress={selectedTier ?? undefined}
              onRedeemed={handleRedeemed}
              revealVersion={revealVersion}
              currentRoundId={roundId}
            />
          )}
          <LifetimeStatsPanel stats={lifetimeStats} />
        </div>
      </div>

      <p className="disclaimer">{t("disclaimer")}</p>
      <FAQSection />
    </main>
  );
}
