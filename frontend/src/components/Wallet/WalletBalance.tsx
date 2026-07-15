import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useBalance } from "../../hooks/useBalance";
import { ulunaToDisplayNumber } from "../../lib/format";

type WalletBalanceProps = {
  // The round's redemption_denom - on testnet this is native uluna (no real
  // USTC/USDC liquidity exists there yet, see project notes), but the copy
  // always talks about USTC since that's what this balance is for: knowing
  // upfront whether a wallet holds enough to redeem a prize.
  denom?: string;
};

export function WalletBalance({ denom }: WalletBalanceProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const balance = useBalance(address, denom);

  if (!address || balance.status !== "loaded") return null;

  return (
    <span className="wallet-balance">
      {t("wallet.ustcBalance", { amount: ulunaToDisplayNumber(balance.amount).toFixed(2) })}
    </span>
  );
}
