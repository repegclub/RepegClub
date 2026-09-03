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
  allowMobile = true,
}: {
  onSelect: (providerId: WalletProviderId, type: WalletType) => void;
  // Hides the "Mobile (scan QR)" (WalletConnect) group - only false for the
  // Hyperlane outbound form (DirectTransferCard.tsx), where it's confirmed
  // to fail 100% of the time (2026-09-02): Keplr mobile via WalletConnect
  // is hardcoded to the old "Amino" sign mode in this project's wallet
  // library, and Amino-signed MsgExecuteContract calls against Terra
  // Classic mainnet don't pass signature verification - proven live with
  // 2 real broadcasts (extension + Keplr's own in-app browser, both using
  // the modern "Direct" mode, both succeeded). The "Keplr"/"Galaxy Station"
  // EXTENSION option above still works fine from a phone too, opened
  // inside that wallet's own in-app browser - see the hint text next to
  // the connect button in DirectOutboundForm.
  allowMobile?: boolean;
}) {
  const { t } = useTranslation();
  return (
    // role="presentation" on the group labels - a role="menu" only accepts
    // menuitem/group/separator children, and these plain labels made the
    // structure invalid for assistive tech (found in CodeRabbit review, PR
    // #35). The 📱 in each mobile option's own aria-hidden span for the
    // same reason - without it, a screen reader announced the emoji as
    // part of the option's name. Each button's own aria-label repeats the
    // connection type too (not just the presentational group label above
    // it) - without it, a screen reader user tabbing button-to-button
    // heard "Keplr" twice with no way to tell the extension option from
    // the mobile one apart (found in CodeRabbit review, PR #35).
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
          aria-label={`${provider.name} — ${t("wallet.groupExtension")}`}
          onClick={() => onSelect(provider.id, WalletType.EXTENSION)}
        >
          {provider.name}
        </button>
      ))}
      {allowMobile && (
        <>
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
              aria-label={`${provider.name} — ${t("wallet.groupMobile")}`}
              onClick={() => onSelect(provider.id, WalletType.WALLETCONNECT)}
            >
              <span aria-hidden="true">📱</span> {provider.name}
            </button>
          ))}
        </>
      )}
    </>
  );
}
