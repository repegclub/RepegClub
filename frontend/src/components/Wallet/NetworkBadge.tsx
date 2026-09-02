import { useTranslation } from "react-i18next";
import { IS_MAINNET } from "../../lib/chainConfig";
import { useWallet } from "../../contexts/WalletContext";

// Visible whenever the wallet ISN'T connected yet (including the error
// state) - the whitepaper explains testnet status clearly, but the site
// itself had no equivalent for someone who lands here without reading it
// first (found while writing the whitepaper), so this can't be something
// you only see after connecting. Once connected, ConnectWalletButton's own
// chip carries the same gold/green network coloring directly (see
// .wallet-chip-testnet in wheel.css) - a separate badge next to it would
// just repeat the same information as its own boxed island, the exact
// wallet-bar space this was folded in to save (2026-09-02, real-phone
// header wrapping to 3 rows - see WheelOfRepeg conversation).
export function NetworkBadge() {
  const { t } = useTranslation();
  const { state } = useWallet();
  if (state.status === "connected") return null;
  return (
    <span className={`network-badge${IS_MAINNET ? " network-badge-main" : ""}`}>
      {IS_MAINNET ? t("wallet.mainnet") : t("wallet.testnet")}
    </span>
  );
}
