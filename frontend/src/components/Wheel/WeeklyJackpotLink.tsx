import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// Cross-promotion the other direction from Weekly Round's own "back to Wheel
// of Repeg" link - reinforces that every round played here also feeds that
// bigger jackpot, even though the two now live on separate pages.
export function WeeklyJackpotLink() {
  const { t } = useTranslation();
  return (
    <Link to="/weekly-round" className="weekly-jackpot-link">
      {t("weekly.navLinkFromWheel")}
    </Link>
  );
}
