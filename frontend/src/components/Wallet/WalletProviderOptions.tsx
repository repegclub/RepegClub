import { useTranslation } from "react-i18next";
import { WalletType } from "@goblinhunt/cosmes/wallet";
import { WALLET_PROVIDERS, type WalletProviderId } from "../../lib/walletProviders";

// Shared list markup for both wallet pickers (the site-wide nav's inline
// dropdown in ConnectWalletButton.tsx, and the onramp's portal-rendered
// WalletProviderPopover.tsx) - grouped by connection type (Extension, then
// Mobile/QR below a divider), not interleaved per-wallet-then-icon. A
// lone 📱 icon button next to each wallet name tested live as invisible as
// a control - nobody could tell it was clickable (found live, 2026-08-19).
export function WalletProviderOptions({
  onSelect,
}: {
  onSelect: (providerId: WalletProviderId, type: WalletType) => void;
}) {
  const { t } = useTranslation();
  return (
    // role="presentation" on the group labels - a role="menu" only accepts
    // menuitem/group/separator children, and these plain labels made the
    // structure invalid for assistive tech (found in CodeRabbit review, PR
    // #35). The 📱 in each mobile option's own aria-hidden span for the
    // same reason - without it, a screen reader announced the emoji as
    // part of the option's name.
    <>
      <div className="wallet-provider-group-label" role="presentation">
        {t("wallet.groupExtension")}
      </div>
      {WALLET_PROVIDERS.map((provider) => (
        <button
          key={`ext-${provider.id}`}
          type="button"
          role="menuitem"
          className="wallet-provider-option"
          onClick={() => onSelect(provider.id, WalletType.EXTENSION)}
        >
          {provider.name}
        </button>
      ))}
      <div className="wallet-provider-divider" />
      <div className="wallet-provider-group-label" role="presentation">
        {t("wallet.groupMobile")}
      </div>
      {WALLET_PROVIDERS.map((provider) => (
        <button
          key={`wc-${provider.id}`}
          type="button"
          role="menuitem"
          className="wallet-provider-option"
          onClick={() => onSelect(provider.id, WalletType.WALLETCONNECT)}
        >
          <span aria-hidden="true">📱</span> {provider.name}
        </button>
      ))}
    </>
  );
}
