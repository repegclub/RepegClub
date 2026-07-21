import { useTranslation } from "react-i18next";
import { useCyolRaffleSummary } from "../../hooks/useCyolRaffleSummary";
import { formatUluna } from "../../lib/format";

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

  const { config, raffleStatus } = summary;

  return (
    <div className="cyol-card">
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
    </div>
  );
}
