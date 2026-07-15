import { useTranslation } from "react-i18next";
import { BulbStrip } from "./BulbStrip";

// Merges the old separate MarqueeSign (title) and SideBanners (hype
// taglines) into one three-panel marquee - the taglines were meant as a
// hook, but as independent full-width blocks they competed with the title
// for top-of-page attention instead of framing it. As panels of the same
// sign, they read as flourish around the title, which is a lot closer to
// what a real fairground marquee looks like.
export function HeroSign() {
  const { t } = useTranslation();
  return (
    <div className="hero-sign">
      <BulbStrip position="top" count={22} />
      <div className="hero-sign-grid">
        <p className="hero-sign-hook hero-sign-hook-left" aria-hidden="true">
          {t("banners.left")}
        </p>
        <div className="hero-sign-title">
          <p className="eyebrow">{t("marquee.eyebrow")}</p>
          <h1>Wheel of Repeg</h1>
        </div>
        <p className="hero-sign-hook hero-sign-hook-right" aria-hidden="true">
          {t("banners.right")}
        </p>
      </div>
      <BulbStrip position="bottom" count={22} />
    </div>
  );
}
