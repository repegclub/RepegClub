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

  // Redeeming USTC doesn't refund the ticket price - it's a separate right
  // won by playing, worth $1 per USTC repegged - so "played" and "repegged"
  // are deliberately never netted against each other in place. This third
  // tile is the one spot that does the netting explicitly, so a winning
  // streak reads as "ahead" without making the lifetime volume stat lie.
  const net = BigInt(stats.totalRedeemed) - BigInt(stats.totalInvested);
  // Round before signing - a tiny negative net (under half a cent) would
  // otherwise display as a confusing "-0.00" (sign applied pre-rounding).
  const netRounded = ulunaToDisplayNumber(net.toString()).toFixed(2);
  const netDisplay = netRounded === "-0.00" ? "0.00" : netRounded;

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
      <div className="lifetime-stats-tile">
        <p className="lifetime-stats-label">{t("lifetimeStats.netLabel")}</p>
        <p className="lifetime-stats-value">
          {net >= 0n ? "+" : ""}
          {netDisplay} USD
        </p>
      </div>
    </section>
  );
}
