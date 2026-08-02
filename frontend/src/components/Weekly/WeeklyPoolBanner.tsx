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
//
// Same lead-card frame + wizard character as Wheel of Repeg's "Win the
// right to repeg" card (see WheelOfRepeg.tsx's inline .lead markup, same
// mago-display.png/alien-wizard.png pair) - paired with PlatformRepeggedBanner
// in WeeklyRoundPage's own .stats-lead-row, mirroring Wheel of Repeg's
// layout/order exactly. Only the text content inside the screen differs
// (a 3-row breakdown instead of a single tagline) - see weekly.css's
// .weekly-pool-lead-text for the font-size/layout overrides that needed.
export function WeeklyPoolBanner({ ticketSalesPool, wheelContributions, pool }: WeeklyPoolBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="lead-outline weekly-pool-lead pixel-stepped-corners">
      <div className="lead-border pixel-stepped-corners">
        <div className="lead-highlight pixel-stepped-corners">
          <div className="lead pixel-stepped-corners">
            <div className="lead-display-wrap">
              <img src="/characters/mago-display.png" alt="" className="lead-display" />
              <img src="/characters/alien-wizard.png" alt="" className="lead-professor" />
              <div className="lead-text weekly-pool-lead-text">
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
