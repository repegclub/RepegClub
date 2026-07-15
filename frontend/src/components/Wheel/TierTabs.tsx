import { useTranslation } from "react-i18next";
import type { TierInfo } from "../../hooks/useWheelTiers";
import { ulunaToDisplayNumber } from "../../lib/format";

type TierTabsProps = {
  tiers: TierInfo[];
  selectedAddress: string;
  onSelect: (address: string) => void;
};

// One tab per deployed Wheel Manager tier, shaped like a small wheel rather
// than a ticket - these switch to an entirely different wheel (its own
// contract, own pool, own players), not a ticket price within the current
// one, so a ticket-stub look was the wrong metaphor (it read as "pick a
// price for this wheel" instead of "go to a different wheel").
export function TierTabs({ tiers, selectedAddress, onSelect }: TierTabsProps) {
  const { t } = useTranslation();
  if (tiers.length <= 1) return null;

  return (
    <div className="tier-tabs" role="tablist">
      {tiers.map((tier) => {
        const active = tier.address === selectedAddress;
        return (
          <button
            key={tier.address}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tier-tab${active ? " tier-tab-active" : ""}`}
            onClick={() => onSelect(tier.address)}
          >
            <span className="tier-tab-wheel-icon" aria-hidden="true">
              <span className="tier-tab-wheel-hub" />
            </span>
            <span className="tier-tab-price">{ulunaToDisplayNumber(tier.ticketPrice).toFixed(2)} USDC</span>
            {tier.myTicketCount > 0 && (
              <span className="tier-tab-badge">{t("tierTabs.myTickets", { count: tier.myTicketCount })}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
