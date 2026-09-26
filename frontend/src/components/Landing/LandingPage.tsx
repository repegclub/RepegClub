import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import "../../styles/wheel.css";
import "../../styles/landing.css";
import { HeroSign } from "../Wheel/HeroSign";
import { GameNav } from "../Shared/GameNav";
import { FAQClassroomPanel } from "../Shared/FAQClassroomPanel";
import { useWheelRound } from "../../hooks/useWheelRound";
import { useWeeklyRound } from "../../hooks/useWeeklyRound";
import { useCyolCounts } from "../../hooks/useCyolCounts";
import { formatUluna } from "../../lib/format";

type StepItem = { title: string; body: string };
type FaqItem = { q: string; a: string };

const REPO_URL = "https://github.com/repegclub/RepegClub";

// Live data refresh while the page stays open. The wheel/weekly queries are
// 2 each, so every minute also keeps the Weekly Round's "closes in" moving;
// the raffle counts cost 1 query per raffle, so they refresh less often.
const ROUNDS_REFRESH_MS = 60_000;
const CYOL_REFRESH_MS = 180_000;

// Calls `fn` every `ms` while the tab is visible - no point querying the
// chain for a page nobody is looking at.
function useVisibleInterval(fn: () => void, ms: number) {
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) fn();
    }, ms);
    return () => clearInterval(id);
  }, [fn, ms]);
}

// "3d 4h" / "5h 12m" / "8m" - coarse on purpose, a teaser on a card rather
// than the live countdown the Weekly Round page itself shows.
function formatTimeLeft(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

// Same 4-layer stepped frame as the rest of the site (outline -> border ->
// highlight -> fill, each clipped with the same fixed-px polygon, see
// .lead-outline in wheel.css), in one of 3 accent colors so the sections
// don't all read the same.
function PixelCard({
  tone,
  className = "",
  children,
}: {
  tone: "gold" | "blue" | "crimson";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`landing-card-outline pixel-stepped-corners ${className}`}>
      <div className={`landing-card-border landing-card-border-${tone} pixel-stepped-corners`}>
        <div className={`landing-card-highlight landing-card-highlight-${tone} pixel-stepped-corners`}>
          <div className="landing-card pixel-stepped-corners">{children}</div>
        </div>
      </div>
    </div>
  );
}

function AttractionCard({
  art,
  artPosition = "center",
  artFit = "cover",
  icon,
  title,
  body,
  status,
  to,
  cta,
}: {
  // Wide strip previewing the section's own main image - artPosition picks
  // which part of it shows (object-position), artFit "contain" is for a
  // cutout (transparent PNG) that should show whole instead of cropped.
  art: string;
  artPosition?: string;
  artFit?: "cover" | "contain";
  icon: string;
  title: string;
  body: string;
  status: string | null;
  to: string;
  cta: string;
}) {
  return (
    <PixelCard tone="blue" className="landing-attraction">
      <img
        src={art}
        alt=""
        className={`landing-attraction-art landing-attraction-art-${artFit}`}
        style={{ objectPosition: artPosition }}
      />
      <div className="landing-attraction-head">
        <img src={icon} alt="" className="landing-attraction-icon" />
        <h3 className="landing-attraction-title">{title}</h3>
      </div>
      <p className="landing-attraction-body">{body}</p>
      {/* Reserved line even while loading, so cards don't jump in height
          when the live numbers arrive. */}
      <p className="landing-attraction-status" aria-live="polite">
        {status ?? " "}
      </p>
      <Link to={to} className="round-action-btn landing-btn landing-attraction-cta">
        {cta}
      </Link>
    </PixelCard>
  );
}

export function LandingPage() {
  const { t } = useTranslation();
  const wheel = useWheelRound();
  const weekly = useWeeklyRound();
  const cyol = useCyolCounts();
  useVisibleInterval(wheel.refetch, ROUNDS_REFRESH_MS);
  useVisibleInterval(weekly.refetch, ROUNDS_REFRESH_MS);
  useVisibleInterval(cyol.refetch, CYOL_REFRESH_MS);

  const howSteps = t("landing.howSteps", { returnObjects: true }) as StepItem[];
  const trustItems = t("landing.trustItems", { returnObjects: true }) as StepItem[];
  const faqItems = t("landing.faq.items", { returnObjects: true }) as FaqItem[];

  let potValue: string | null = null;
  let wheelStatus: string | null = null;
  if (wheel.status === "loaded") {
    const { round, config } = wheel;
    potValue = formatUluna(round.pool, "USDC");
    if (round.status === "open") {
      const missing = config.min_players - round.unique_player_count;
      wheelStatus =
        missing > 0
          ? t("landing.playersNeeded", { count: missing })
          : t("landing.wheelLive", { count: round.unique_player_count });
    } else if (round.status === "closed") {
      wheelStatus = t("landing.wheelDrawing");
    }
  }

  let weeklyStatus: string | null = null;
  if (weekly.status === "loaded") {
    const { week } = weekly;
    weeklyStatus =
      week.status === "open"
        ? t("landing.weekly.live", {
            pot: formatUluna(week.pool, "USDC"),
            time: formatTimeLeft(week.seconds_remaining),
          })
        : week.status === "closed"
          ? t("landing.weekly.drawing")
          : null;
  }

  let rafflesStatus: string | null = null;
  let airdropsStatus: string | null = null;
  let creatorsStatus: string | null = null;
  if (cyol.status === "loaded") {
    const c = cyol.counts;
    // Incomplete data (see CyolCounts.splitComplete) can only undercount:
    // show what was found as a floor ("N+"), and say nothing rather than
    // claim "none live" when some raffle's status couldn't be read.
    const liveLabel = (kind: "raffles" | "airdrops", count: number) =>
      count > 0
        ? t(c.splitComplete ? `landing.${kind}.live` : `landing.${kind}.liveAtLeast`, { count })
        : c.splitComplete
          ? t(`landing.${kind}.none`)
          : null;
    rafflesStatus = liveLabel("raffles", c.liveRaffles);
    airdropsStatus = liveLabel("airdrops", c.liveAirdrops);
    creatorsStatus =
      c.totalCreated === 0
        ? t("landing.creators.none")
        : c.splitComplete
          ? t("landing.creators.created", { raffles: c.createdRaffles, airdrops: c.createdAirdrops })
          : t("landing.creators.createdTotal", { count: c.totalCreated });
  }

  return (
    <main className="landing-page">
      {/* Navigation only - no wallet controls here on purpose, nothing on
          this page needs a connected wallet. */}
      <div className="wallet-bar">
        <GameNav current="/" />
      </div>

      <HeroSign title="Repeg Club" eyebrow={t("landing.eyebrow")} />
      <p className="landing-lore">{t("landing.lore")}</p>

      {/* Wide screens: hero + attractions side by side, then how/trust/
          onramp in one row below - the whole fair fits in one screen
          (see landing.css). Narrow: everything stacks in this same order. */}
      <div className="landing-top">
        <h2 className="landing-section-title landing-main-title">{t("landing.mainTitle")}</h2>
        <PixelCard tone="gold" className="landing-hero">
          <div className="landing-hero-grid">
            <div className="landing-hero-copy">
              <div className="landing-headline-row">
                <img src="/characters/host.png" alt="" className="landing-hero-host" />
                <h2 className="landing-headline">{t("landing.headline")}</h2>
              </div>
              {wheel.status !== "error" && (
                <div className="landing-pot" aria-live="polite">
                  <span className="landing-pot-label">{t("landing.potLabel")}</span>
                  <span className="landing-pot-value">{potValue ?? t("landing.potLoading")}</span>
                  {wheelStatus && <span className="landing-pot-status">{wheelStatus}</span>}
                </div>
              )}
              <div className="landing-cta-row">
                <Link to="/wheel" className="booth-buy landing-btn">
                  {t("landing.ctaPlay")}
                </Link>
                <a href="#attractions" className="landing-btn landing-btn-secondary">
                  {t("landing.ctaExplore")}
                </a>
              </div>
            </div>
          </div>
        </PixelCard>

        {/* id on the title, not the section: from 1100px up the section is
            display:contents (see landing.css), which has no box of its own
            for the "Explore the fair" anchor to scroll to. */}
        <section className="landing-attractions-section">
          <h2 className="landing-section-title landing-attractions-title" id="attractions">
            {t("landing.attractionsTitle")}
          </h2>
          <div className="landing-attractions">
            <AttractionCard
              art="/weekly-pixel/booth-bg.png"
              artPosition="center 38%"
              icon="/wheel-pixel/crown-emoji.png"
              title={t("landing.weekly.title")}
              body={t("landing.weekly.body")}
              status={weeklyStatus}
              to="/weekly-round"
              cta={t("landing.weekly.cta")}
            />
            <AttractionCard
              art="/characters/galactic-raffle-banner.jpg"
              artPosition="center 25%"
              icon="/wheel-pixel/clover-emoji.png"
              title={t("landing.raffles.title")}
              body={t("landing.raffles.body")}
              status={rafflesStatus}
              to="/create-your-own-luck"
              cta={t("landing.raffles.cta")}
            />
            <AttractionCard
              art="/wheel-pixel/cyol-chest-open.png"
              artFit="contain"
              icon="/wheel-pixel/airdrop-emoji.png"
              title={t("landing.airdrops.title")}
              body={t("landing.airdrops.body")}
              status={airdropsStatus}
              to="/create-your-own-luck?view=airdrops"
              cta={t("landing.airdrops.cta")}
            />
            <AttractionCard
              art="/characters/creators-lab-banner.jpg"
              artPosition="center 30%"
              icon="/wheel-pixel/creators-icon.png"
              title={t("landing.creators.title")}
              body={t("landing.creators.body")}
              status={creatorsStatus}
              to="/creators"
              cta={t("landing.creators.cta")}
            />
          </div>
        </section>
      </div>

      <div className="landing-bottom">
        <PixelCard tone="gold" className="landing-how">
          {/* design-references/characters/Boletería con contexto.png, trimmed
              on both sides (the right trim drops its Gemini watermark). */}
          <img src="/characters/ticket-booth-context.jpg" alt="" className="landing-how-art" />
          <h2 className="landing-card-title">{t("landing.howTitle")}</h2>
          <ol className="landing-steps">
            {howSteps.map((step, i) => (
              <li key={step.title}>
                <span className="landing-step-number">{i + 1}</span>
                <div>
                  <strong className="landing-step-title">{step.title}</strong>
                  <span className="landing-step-body"> {step.body}</span>
                </div>
              </li>
            ))}
          </ol>
        </PixelCard>

        <PixelCard tone="crimson" className="landing-trust">
          {/* Same lab scene as the Verify popup's header, cropped around the
              scientist. */}
          <img src="/characters/verify-lab-panel.png" alt="" className="landing-trust-art" />
          <h2 className="landing-card-title landing-trust-title">{t("landing.trustTitle")}</h2>
          <ul className="landing-trust-list">
            {trustItems.map((item) => (
              <li key={item.title}>
                <strong>{item.title}.</strong> {item.body}
              </li>
            ))}
          </ul>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="booth-buy landing-btn landing-card-cta"
          >
            {t("landing.repoLink")}
          </a>
        </PixelCard>

        <PixelCard tone="blue" className="landing-onramp">
          <img src="/characters/onramp-counter.jpg" alt="" className="landing-onramp-art" />
          <h2 className="landing-card-title">{t("landing.onramp.title")}</h2>
          <p className="landing-onramp-body">{t("landing.onramp.body")}</p>
          <Link to="/onramp" className="booth-buy landing-btn landing-card-cta">
            {t("landing.onramp.cta")}
          </Link>
        </PixelCard>
      </div>

      <FAQClassroomPanel
        title={t("landing.faq.title")}
        items={faqItems}
        screenPrompt={t("faq.screenPrompt")}
        screenPlaceholder={t("faq.screenPlaceholder")}
        answerLabel={t("faq.screenAnswerLabel")}
      />
    </main>
  );
}
