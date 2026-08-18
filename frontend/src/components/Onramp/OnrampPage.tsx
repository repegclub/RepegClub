import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/onramp.css";
import { FAQClassroomPanel } from "../Shared/FAQClassroomPanel";
import { GameNav } from "../Shared/GameNav";
import { HostGuide } from "../Wheel/HostGuide";
import { OriginOptionsPanel } from "./OriginOptionsPanel";
import { DirectTransferCard } from "./DirectTransferCard";

export function OnrampPage() {
  const { t } = useTranslation();

  // Same guarded/cycling pattern as TicketBooth's hostHype - see the
  // comment there for why returnObjects needs the isArray/filter guard.
  const hostHype = t("onramp.hostHype", { returnObjects: true });
  const HYPE_LINES = Array.isArray(hostHype)
    ? hostHype.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    : [];
  const [hypeIndex, setHypeIndex] = useState(0);
  useEffect(() => {
    if (HYPE_LINES.length === 0) return;
    const id = setInterval(() => setHypeIndex((i) => (i + 1) % HYPE_LINES.length), 8000);
    return () => clearInterval(id);
  }, [HYPE_LINES.length]);

  return (
    <main className="onramp-page">
      {/* Same .wallet-bar (GameNav + status pill) every other page uses -
          lets someone jump to a game and back instead of the old lone
          "back to Wheel of Repeg" link. The badge here is hardcoded to
          mainnet, not the shared NetworkBadge component - that one reads
          the site-wide IS_MAINNET flag (still testnet for Wheel of
          Repeg/Weekly Round/CYOL today), but the onramp's direct-transfer
          flow always runs on real mainnet chains regardless of that flag.
          Showing "Testnet" here would be actively wrong, not just stale. */}
      <div className="wallet-bar">
        <GameNav current="/onramp" />
        <span className="network-badge network-badge-main">{t("onramp.mainnetBadge")}</span>
      </div>

      <h1 className="onramp-title">{t("onramp.title")}</h1>

      {/* Pure decorative banner, not a fixed "screen" meant to contain the
          widget below - the widget has no fixed size (its asset-selector
          modal is taller than its base state), so forcing it inside a drawn
          frame would break as soon as someone interacts with it. Same
          boletería pattern already used by TicketBooth: art on top, real
          content below in normal flow. */}
      <div className="onramp-banner-border panel-border pixel-stepped-corners">
        <div className="panel-highlight pixel-stepped-corners">
          <div className="onramp-banner-wrap">
            <img src="/characters/onramp-counter.jpg" alt="" className="onramp-banner pixel-stepped-corners" />
            <p className="onramp-banner-screen-text">
              Onramp
              <br />
              Your
              <br />
              USDC
            </p>
            <div className="onramp-host-bubble">
              {HYPE_LINES[hypeIndex] && <HostGuide message={HYPE_LINES[hypeIndex]} bubbleType="rectangulo" />}
            </div>
          </div>
        </div>
      </div>

      <p className="onramp-subtitle">{t("onramp.subtitle")}</p>

      <OriginOptionsPanel />

      {/* One pixel-art frame around the whole tool (same panel-border/
          panel-highlight chrome as the banner above) - everything inside it
          (tabs, the direct-transfer form, or the embedded widget) shares one
          rounded "widget-style" look instead of the site's usual pixel
          chrome, so switching tabs never looks like switching products (see
          DirectTransferCard.tsx). */}
      <div className="onramp-tool-frame panel-border pixel-stepped-corners">
        <div className="panel-highlight pixel-stepped-corners">
          <DirectTransferCard />
        </div>
      </div>

      <FAQClassroomPanel
        title={t("onrampFaq.title")}
        items={t("onrampFaq.items", { returnObjects: true }) as { q: string; a: string }[]}
        screenPrompt={t("onrampFaq.screenPrompt")}
        screenPlaceholder={t("onrampFaq.screenPlaceholder")}
        answerLabel={t("onrampFaq.screenAnswerLabel")}
      />
    </main>
  );
}
