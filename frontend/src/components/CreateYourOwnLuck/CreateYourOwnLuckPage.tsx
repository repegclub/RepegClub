import { useTranslation } from "react-i18next";
import { GameSwitcher } from "../Shared/GameSwitcher";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { useCyolRaffles } from "../../hooks/useCyolRaffles";

// Step 1 of the build (scaffolding: route + factory query wired up and
// proven live) - deliberately bare-bones. The real discovery layout (raffle
// cards, the "I'm a creator" form) is step 2; this just confirms the
// plumbing works end-to-end before investing in that UI.
export function CreateYourOwnLuckPage() {
  const { t } = useTranslation();
  const raffles = useCyolRaffles();

  return (
    <main className="wheel-page">
      <div className="wallet-bar">
        <ConnectWalletButton />
      </div>

      <h1>{t("createYourOwnLuck.pageTitle")}</h1>

      <GameSwitcher current="/create-your-own-luck" />

      <h2>{t("createYourOwnLuck.raffleListTitle")}</h2>
      {raffles.status === "loading" && <p>{t("createYourOwnLuck.loading")}</p>}
      {raffles.status === "error" && <p>{t("createYourOwnLuck.error")}</p>}
      {raffles.status === "loaded" && raffles.raffles.raffles.length === 0 && (
        <p>{t("createYourOwnLuck.empty")}</p>
      )}
      {raffles.status === "loaded" && raffles.raffles.raffles.length > 0 && (
        <ul>
          {raffles.raffles.raffles.map((raffle) => (
            <li key={raffle.index}>
              {raffle.address} — {t("createYourOwnLuck.createdBy", { creator: raffle.creator })}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
