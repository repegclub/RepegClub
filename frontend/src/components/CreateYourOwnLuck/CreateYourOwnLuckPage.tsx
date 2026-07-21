import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameSwitcher } from "../Shared/GameSwitcher";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { useCyolRaffles } from "../../hooks/useCyolRaffles";
import { RaffleCard } from "./RaffleCard";
import { CreatorForm } from "./CreatorForm";

// Step 2: the real discovery page (raffle cards with live status/price, the
// "I'm a creator" form) on top of step 1's proven-working plumbing.
export function CreateYourOwnLuckPage() {
  const { t } = useTranslation();
  const raffles = useCyolRaffles();

  return (
    <main className="wheel-page cyol-page">
      <div className="wallet-bar">
        <ConnectWalletButton />
      </div>

      <h1 className="cyol-title">{t("createYourOwnLuck.pageTitle")}</h1>

      <GameSwitcher current="/create-your-own-luck" />

      <CreatorForm onCreated={raffles.refetch} />

      <h2 className="cyol-list-title">{t("createYourOwnLuck.raffleListTitle")}</h2>
      {raffles.status === "loading" && <p>{t("createYourOwnLuck.loading")}</p>}
      {raffles.status === "error" && <p>{t("createYourOwnLuck.error")}</p>}
      {raffles.status === "loaded" && raffles.raffles.raffles.length === 0 && (
        <p>{t("createYourOwnLuck.empty")}</p>
      )}
      {raffles.status === "loaded" && raffles.raffles.raffles.length > 0 && (
        <>
          {raffles.raffles.raffles.length < raffles.raffles.total_count && (
            <p className="cyol-partial-note">
              {t("createYourOwnLuck.partialList", {
                shown: raffles.raffles.raffles.length,
                total: raffles.raffles.total_count,
              })}
            </p>
          )}
          <div className="cyol-card-grid">
            {raffles.raffles.raffles.map((raffle) => (
              <RaffleCard key={raffle.index} address={raffle.address} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
