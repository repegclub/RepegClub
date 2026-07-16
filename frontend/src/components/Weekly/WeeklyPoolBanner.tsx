import { useTranslation } from "react-i18next";
import { formatUluna } from "../../lib/format";

type WeeklyPoolBannerProps = {
  ticketSalesPool: string;
  wheelContributions: string;
  pool: string;
};

// The whole reason this jackpot reads as "the big one": it's not just this
// week's ticket sales, it's fed by every Wheel of Repeg round on the
// platform. Showing the two sources separately (instead of just the total)
// is what makes that connection legible at a glance, in the same spirit of
// transparency as the "Verify this round" panel.
export function WeeklyPoolBanner({ ticketSalesPool, wheelContributions, pool }: WeeklyPoolBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="weekly-pool-banner">
      <p className="weekly-pool-banner-title">{t("weekly.poolBreakdownTitle")}</p>
      <div className="weekly-pool-banner-rows">
        <div className="weekly-pool-banner-row">
          <span>{t("weekly.poolBreakdownTicketSales")}</span>
          <span className="weekly-pool-banner-amount">{formatUluna(ticketSalesPool, "USDC")}</span>
        </div>
        <div className="weekly-pool-banner-row">
          <span>{t("weekly.poolBreakdownWheelContributions")}</span>
          <span className="weekly-pool-banner-amount">{formatUluna(wheelContributions, "USDC")}</span>
        </div>
        <div className="weekly-pool-banner-row weekly-pool-banner-total">
          <span>{t("weekly.poolBreakdownTotal")}</span>
          <span className="weekly-pool-banner-amount">{formatUluna(pool, "USDC")}</span>
        </div>
      </div>
    </div>
  );
}
