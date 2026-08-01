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
    <div className="hero-sign-outline">
      <div className="hero-sign">
        <div className="hero-sign-highlight">
          <div className="hero-sign-inner">
            <BulbStrip position="top" count={22} />
            <div className="hero-sign-grid">
              <img
                src="/wheel-pixel/marquee-left.png"
                alt={t("banners.left")}
                className="hero-sign-hook hero-sign-hook-left"
              />
              <div className="hero-sign-title">
                <h1>Wheel of Repeg</h1>
              </div>
              <img
                src="/wheel-pixel/marquee-right.png"
                alt={t("banners.right")}
                className="hero-sign-hook hero-sign-hook-right"
              />
            </div>
            <BulbStrip position="bottom" count={22} />
          </div>
        </div>
      </div>
    </div>
  );
}
