import { useTranslation } from "react-i18next";
import type { PlatformRepeggedState } from "../../hooks/usePlatformRepegged";
import { ulunaToDisplayNumber } from "../../lib/format";
import { BulbStrip } from "./BulbStrip";

type PlatformRepeggedBannerProps = {
  stats: PlatformRepeggedState;
};

// Public, platform-wide (not gated behind a connected wallet) - meant to be
// the first thing anyone entering the site sees: real proof of how much the
// app has actually repegged so far, not a per-wallet stat. Takes the
// already-fetched state as a prop (rather than querying itself) so the
// parent can refetch it after a redeem changes the total.
export function PlatformRepeggedBanner({ stats }: PlatformRepeggedBannerProps) {
  const { t } = useTranslation();

  if (stats.status !== "loaded") return null;

  return (
    <div className="platform-repegged-banner">
      <div className="platform-repegged-glow" />
      <BulbStrip position="top" count={10} />
      <p className="platform-repegged-label">{t("platformRepegged.label")}</p>
      <p className="platform-repegged-amount">
        {ulunaToDisplayNumber(stats.totalRedeemed).toFixed(2)}
      </p>
      <p className="platform-repegged-tagline">{t("platformRepegged.tagline")}</p>
      <BulbStrip position="bottom" count={10} />
    </div>
  );
}
