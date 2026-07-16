import { useTranslation } from "react-i18next";
import { BulbStrip } from "../Wheel/BulbStrip";

export function WeeklyHeroSign() {
  const { t } = useTranslation();
  return (
    <div className="hero-sign weekly-hero-sign">
      <BulbStrip position="top" count={22} />
      <div className="hero-sign-grid weekly-hero-sign-grid">
        <div className="hero-sign-title">
          <p className="eyebrow">{t("marquee.eyebrow")}</p>
          <h1 className="weekly-hero-title">{t("weekly.heroTitle")}</h1>
          <p className="weekly-hero-subtitle">{t("weekly.heroSubtitle")}</p>
        </div>
      </div>
      <BulbStrip position="bottom" count={22} />
    </div>
  );
}
