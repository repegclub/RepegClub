import { useTranslation } from "react-i18next";

// Same 4-layer pixel frame as Wheel of Repeg's own HeroSign (hero-sign-
// outline (black) > hero-sign (gold-dim) > hero-sign-highlight (gold) >
// hero-sign-inner (actual fill)) - this was missing the outer 3 layers
// before, just a single div with .hero-sign's own flat gold-dim background
// and clip-path shape, which is why it read as a solid-colored block with
// no visible border at all next to the other framed cards (reported live).
// Same title+2-signs composition as Wheel of Repeg's own HeroSign now too -
// no subtitle paragraph (dropped per direct request), the 2 marquee signs
// (cartel1/cartel2, your own art) carry that "hook" role instead, same as
// Wheel of Repeg's "The only f*cking REPEG..."/"Feeling lucky?" pair.
export function WeeklyHeroSign() {
  const { t } = useTranslation();
  return (
    <div className="hero-sign-outline weekly-hero-sign-outline">
      <div className="hero-sign weekly-hero-sign">
        <div className="hero-sign-highlight">
          <div className="hero-sign-inner">
            <div className="hero-sign-grid weekly-hero-sign-grid">
              <img
                src="/weekly-pixel/marquee-left.png"
                alt={t("weekly.bannerLeft")}
                className="hero-sign-hook hero-sign-hook-left"
              />
              <div className="hero-sign-title">
                <h1 className="weekly-hero-title">{t("weekly.heroTitle")}</h1>
              </div>
              <img
                src="/weekly-pixel/marquee-right.png"
                alt={t("weekly.bannerRight")}
                className="hero-sign-hook hero-sign-hook-right"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
