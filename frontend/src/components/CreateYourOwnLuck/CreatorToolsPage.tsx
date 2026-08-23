import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameNav } from "../Shared/GameNav";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { NetworkBadge } from "../Wallet/NetworkBadge";
import { WalletBalance } from "../Wallet/WalletBalance";
import { CreatorForm } from "./CreatorForm";
import { CyolOptionsPanel } from "./CyolOptionsPanel";

// Split off CreateYourOwnLuckPage (2026-08-20, direct request) - that page
// mixed the raffle-creation form with the raffle list to play, forcing
// anyone who just wants to play to scroll past a form aimed at a different
// audience. This page is the creator-facing half - reachable from the
// "Create" nav link (GameNav.tsx), not the "Raffles" one - and is meant to
// grow into a real hub: more creator tools (eg. an embeddable onramp
// widget, floated 2026-08-19) will land here as their own sections
// alongside the raffle form, not on separate pages of their own. No
// onCreated callback into CreatorForm - unlike the old combined page, there's
// no raffle list on this page to refresh; CreatorForm already navigates
// straight to the new raffle's own page on success regardless.
export function CreatorToolsPage() {
  const { t } = useTranslation();

  return (
    <main className="wheel-page cyol-page">
      <div className="wallet-bar">
        <GameNav current="/creators" />
        <div className="wallet-bar-right">
          <div className="wallet-status-group">
            <NetworkBadge />
            <ConnectWalletButton />
          </div>
          <div className="wallet-bar-secondary">
            <WalletBalance />
          </div>
        </div>
      </div>

      <h1 className="cyol-title">{t("creatorTools.pageTitle")}</h1>

      {/* Creators Lab / Dev Hub art (2026-08-20, direct request) - same
          alien-lore treatment as CreateYourOwnLuckPage.tsx's Galactic
          Raffle banner, shares its CSS (.cyol-page-banner*). */}
      <div className="cyol-page-banner-border panel-border pixel-stepped-corners">
        <div className="panel-highlight pixel-stepped-corners">
          <img src="/characters/creators-lab-banner.jpg" alt="" className="cyol-page-banner pixel-stepped-corners" />
        </div>
      </div>

      <CyolOptionsPanel />

      {/* 2 separate tools, not 1 form with a type switch (direct request,
          2026-08-20) - an Airdrop has no winner, so folding it under the
          same "raffle" framing as SingleWinner misrepresented what it is.
          See CreatorForm.tsx's own comment on `mode` for the full reasoning. */}
      <h2 className="cyol-list-title">{t("creatorTools.raffleFormTitle")}</h2>
      <CreatorForm mode="raffle" />

      <h2 className="cyol-list-title">{t("creatorTools.airdropFormTitle")}</h2>
      <CreatorForm mode="airdrop" />
    </main>
  );
}
