import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import type { LifetimeStatsState } from "../../hooks/useLifetimeStats";
import { ulunaToDisplayNumber } from "../../lib/format";

type LifetimeStatsPanelProps = {
  stats: LifetimeStatsState;
};

// Whole-platform totals (summed across every tier + Weekly Round, see
// hooks/useLifetimeStats.ts) - lets a wallet with a winning streak see
// concretely whether they've actually come out ahead, not just whether
// they've won a specific round. Takes the already-fetched state as a prop
// (rather than querying itself) so the parent can refetch it after actions
// that change the numbers (buying a ticket, redeeming a prize).
export function LifetimeStatsPanel({ stats }: LifetimeStatsPanelProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;

  if (!address || stats.status !== "loaded") return null;
  if (stats.totalInvested === "0" && stats.totalRedeemed === "0") return null;

  return (
    <section className="lifetime-stats-panel">
      <div className="lifetime-stats-tile">
        <p className="lifetime-stats-label">{t("lifetimeStats.investedLabel")}</p>
        <p className="lifetime-stats-value">{ulunaToDisplayNumber(stats.totalInvested).toFixed(2)} USDC</p>
      </div>
      <div className="lifetime-stats-tile">
        <p className="lifetime-stats-label">{t("lifetimeStats.repeggedLabel")}</p>
        <p className="lifetime-stats-value">{ulunaToDisplayNumber(stats.totalRedeemed).toFixed(2)} USTC</p>
      </div>
    </section>
  );
}
