import { useTranslation } from "react-i18next";
import { IS_MAINNET } from "../../lib/chainConfig";

// Always visible, on every page, regardless of wallet connection state -
// the whitepaper explains testnet status clearly, but the site itself had
// no equivalent for someone who lands here without reading it first (found
// while writing the whitepaper). Sits next to Connect Keplr/the wallet chip
// so it's never missed right when it matters most - about to sign a tx.
export function NetworkBadge() {
  const { t } = useTranslation();
  return (
    <span className={`network-badge${IS_MAINNET ? " network-badge-main" : ""}`}>
      {IS_MAINNET ? t("wallet.mainnet") : t("wallet.testnet")}
    </span>
  );
}
