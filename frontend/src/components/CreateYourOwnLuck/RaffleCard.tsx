import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useCyolRaffleSummary } from "../../hooks/useCyolRaffleSummary";
import { formatUluna } from "../../lib/format";
import { prizeCurrencyLabel, formatAmount } from "../../lib/cyolFormat";
import { CyolVerifyPanel } from "./CyolVerifyPanel";

const RAFFLE_TYPE_LABEL_KEYS: Record<string, string> = {
  single_winner: "createYourOwnLuck.raffleType.singleWinner",
  podium: "createYourOwnLuck.raffleType.podium",
  airdrop: "createYourOwnLuck.raffleType.airdrop",
};

export function RaffleCard({ address }: { address: string }) {
  const { t } = useTranslation();
  const summary = useCyolRaffleSummary(address);

  if (summary.status === "loading") {
    return <div className="cyol-card cyol-card-loading">{t("createYourOwnLuck.loading")}</div>;
  }
  if (summary.status === "error") {
    return <div className="cyol-card cyol-card-error">{t("createYourOwnLuck.cardError")}</div>;
  }

  const { config, raffleStatus, winners } = summary;
  const singleWinner = winners && winners.winners.length === 1 ? winners.winners[0] : null;

  return (
    <Link to={`/create-your-own-luck/${address}`} className="cyol-card">
      <div className="cyol-card-top">
        <span className="cyol-card-type">{t(RAFFLE_TYPE_LABEL_KEYS[config.raffle_type])}</span>
        <span className={`cyol-card-status cyol-card-status-${raffleStatus.status}`}>
          {t(`createYourOwnLuck.status.${raffleStatus.status}`)}
        </span>
      </div>
      <p className="cyol-card-price">
        {t("createYourOwnLuck.ticketPrice", { price: formatUluna(config.ticket_price, "USDC") })}
      </p>
      <p className="cyol-card-players">
        {t("createYourOwnLuck.players", {
          count: raffleStatus.unique_player_count,
          max: config.max_players,
        })}
      </p>
      <p className="cyol-card-address">{address}</p>
      {singleWinner && (
        <>
          <p className="cyol-detail-line cyol-detail-highlight">
            {t("createYourOwnLuck.detail.winnerLine", {
              winner: singleWinner,
              prize: formatAmount(
                winners!.prize_shares[0] ?? "0",
                prizeCurrencyLabel("native" in config.prize_asset ? config.prize_asset.native.denom : config.usdc_denom)
              ),
            })}
          </p>
          <CyolVerifyPanel contractAddress={address} winnerAddress={singleWinner} />
        </>
      )}
    </Link>
  );
}
