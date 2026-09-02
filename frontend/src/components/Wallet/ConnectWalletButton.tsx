import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { IS_MAINNET } from "../../lib/chainConfig";
import { WALLET_PROVIDERS } from "../../lib/walletProviders";
import { WalletProviderOptions } from "./WalletProviderOptions";

function truncate(address: string): string {
  return `${address.slice(0, 10)}...${address.slice(-4)}`;
}

// Narrow phones only (see .wallet-address-short/-full in wheel.css) - the
// wallet-bar is already tight there once Games/Creators sit next to it, and
// the full truncated form is still 17 characters wide.
function truncateShort(address: string): string {
  return `...${address.slice(-4)}`;
}

export function ConnectWalletButton() {
  const { t } = useTranslation();
  const { state, connect, disconnect } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);

  if (state.status === "connected") {
    return (
      <div className={`wallet-chip${IS_MAINNET ? "" : " wallet-chip-testnet"}`}>
        <span className="wallet-chip-network">{IS_MAINNET ? t("wallet.mainnet") : t("wallet.testnet")}</span>
        <span className="wallet-dot" />
        <span className="wallet-address-full">{truncate(state.address)}</span>
        <span className="wallet-address-short">{truncateShort(state.address)}</span>
        <button className="wallet-disconnect" onClick={disconnect}>
          {t("wallet.disconnect")}
        </button>
      </div>
    );
  }

  if (state.status === "error") {
    const provider = WALLET_PROVIDERS.find((p) => p.id === state.providerId)!;
    return (
      <div className="wallet-chip wallet-chip-error">
        <span className="wallet-error-msg">{t(`wallet.${state.kind}`, { provider: provider.name })}</span>
        {state.kind === "notInstalled" ? (
          <a className="wallet-connect-btn" href={provider.installUrl} target="_blank" rel="noreferrer">
            {t("wallet.install", { provider: provider.name })}
          </a>
        ) : (
          <button className="wallet-connect-btn" onClick={() => connect(state.providerId, state.type)}>
            {t("wallet.retry")}
          </button>
        )}
        {/* Without this, a rejected/failed attempt only offers Retry on
            the SAME provider - a user who backed out of Keplr on purpose
            (wrong wallet, changed their mind) had no way back to the
            picker short of reloading the page (found live, 2026-08-19). */}
        <button className="wallet-disconnect" onClick={disconnect}>
          {t("wallet.chooseAnother")}
        </button>
      </div>
    );
  }

  return (
    // tabIndex + onBlur (checking the new focus target is still inside this
    // wrapper) closes the picker on an outside click/tab-away, without a
    // click-outside listener/library - same trick used nowhere else yet in
    // this codebase, but the smallest one that works here.
    <div
      className="wallet-picker-wrap"
      tabIndex={-1}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false);
      }}
    >
      <button
        className="wallet-connect-btn"
        onClick={() => setMenuOpen((open) => !open)}
        disabled={state.status === "connecting"}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {state.status === "connecting" ? t("wallet.connecting") : t("wallet.connect")}
      </button>
      {menuOpen && (
        <div className="wallet-provider-menu" role="menu">
          <WalletProviderOptions
            onSelect={(providerId, type) => {
              setMenuOpen(false);
              connect(providerId, type);
            }}
          />
        </div>
      )}
    </div>
  );
}
