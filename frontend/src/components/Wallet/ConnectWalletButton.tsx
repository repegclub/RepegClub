import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";

function truncate(address: string): string {
  return `${address.slice(0, 10)}...${address.slice(-4)}`;
}

export function ConnectWalletButton() {
  const { t } = useTranslation();
  const { state, connect, disconnect } = useWallet();

  if (state.status === "connected") {
    return (
      <div className="wallet-chip">
        <span className="wallet-dot" />
        <span className="wallet-address">{truncate(state.address)}</span>
        <button className="wallet-disconnect" onClick={disconnect}>
          {t("wallet.disconnect")}
        </button>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="wallet-chip wallet-chip-error">
        <span className="wallet-error-msg">{t(`wallet.${state.kind}`)}</span>
        {state.kind === "notInstalled" ? (
          <a
            className="wallet-connect-btn"
            href="https://www.keplr.app/"
            target="_blank"
            rel="noreferrer"
          >
            {t("wallet.install")}
          </a>
        ) : (
          <button className="wallet-connect-btn" onClick={connect}>
            {t("wallet.retry")}
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      className="wallet-connect-btn"
      onClick={connect}
      disabled={state.status === "connecting"}
    >
      {state.status === "connecting" ? t("wallet.connecting") : t("wallet.connect")}
    </button>
  );
}
