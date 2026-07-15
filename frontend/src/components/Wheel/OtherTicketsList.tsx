import { useTranslation } from "react-i18next";
import type { TierInfo } from "../../hooks/useWheelTiers";
import { ulunaToDisplayNumber } from "../../lib/format";

type OtherTicketsListProps = {
  tiers: TierInfo[];
  selectedAddress: string;
  onSelect: (address: string) => void;
};

// Stacks under the ticket booth - one row per OTHER tier where the wallet
// already holds a ticket, so switching tiers doesn't make an active ticket
// somewhere else disappear from view. Also the main thing that naturally
// fills vertical space as a wallet gets more involved across tiers, instead
// of leaving empty room next to the wheel.
export function OtherTicketsList({ tiers, selectedAddress, onSelect }: OtherTicketsListProps) {
  const { t } = useTranslation();
  const others = tiers.filter((tier) => tier.address !== selectedAddress && tier.myTicketCount > 0);
  if (others.length === 0) return null;

  return (
    <div className="other-tickets-list">
      <p className="other-tickets-title">{t("otherTickets.title")}</p>
      {others.map((tier) => (
        <button
          key={tier.address}
          type="button"
          className="other-tickets-row"
          onClick={() => onSelect(tier.address)}
        >
          <span className="other-tickets-price">{ulunaToDisplayNumber(tier.ticketPrice).toFixed(2)} USDC</span>
          <span className="other-tickets-count">{t("entrants.ticket", { count: tier.myTicketCount })}</span>
        </button>
      ))}
    </div>
  );
}
