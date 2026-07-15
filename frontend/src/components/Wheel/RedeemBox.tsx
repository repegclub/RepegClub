import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useBalance } from "../../hooks/useBalance";
import { redeem } from "../../lib/roundActions";
import { displayNumberToUluna, ulunaToDisplayNumber } from "../../lib/format";

type RedeemBoxProps = {
  roundId: number;
  redemptionDenom: string;
  prizeRemainingUluna: string;
  unclaimedDeadlineDays: number;
  contractAddress?: string;
  onRedeemed?: () => void;
};

// Self-contained redeem flow (amount input, Max button, live receive
// preview, and the actual signed tx) - reused both right after watching a
// round's reveal and from the "My winnings" list, so a wallet doesn't need
// to keep that specific round "pinned" in the UI to come back and redeem.
export function RedeemBox({
  roundId,
  redemptionDenom,
  prizeRemainingUluna,
  unclaimedDeadlineDays,
  contractAddress,
  onRedeemed,
}: RedeemBoxProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const balance = useBalance(address, redemptionDenom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRedeemed, setJustRedeemed] = useState(false);
  // null = not yet touched, tracks the live prize amount as the default.
  const [amountInput, setAmountInput] = useState<string | null>(null);

  const prizeRemainingDisplay = ulunaToDisplayNumber(prizeRemainingUluna);
  // null (untouched, or "Max" was clicked) means "send the exact remaining
  // amount" - deliberately NOT reconstructed from the 2-decimal display
  // string, which can round UP past the true remaining amount (a prize
  // split doesn't always land on a clean cent) and make the suggested
  // default silently fail its own validation below. Comparing in raw uluna
  // (integers) rather than the rounded display float sidesteps floating-
  // point precision entirely.
  const usingFullAmount = amountInput === null;
  const amountUluna = usingFullAmount ? prizeRemainingUluna : displayNumberToUluna(Number(amountInput));
  const amountValue = usingFullAmount
    ? prizeRemainingDisplay > 0
      ? prizeRemainingDisplay.toFixed(2)
      : "0"
    : amountInput;
  const amountNumber = Number(amountValue);
  const amountValid =
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    BigInt(amountUluna || "0") <= BigInt(prizeRemainingUluna);

  async function handleRedeem() {
    if (walletState.status !== "connected" || !amountValid) return;
    setBusy(true);
    setError(null);
    try {
      await redeem(walletState.wallet, roundId, redemptionDenom, amountUluna, contractAddress);
      setJustRedeemed(true);
      balance.refetch();
      onRedeemed?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Not one of our own ContractError variants - the chain's bank module
      // rejects the tx before it even reaches the contract if the wallet
      // doesn't hold enough of the attached denom. Give a concrete next
      // step instead of the raw "insufficient funds: spendable balance..."
      // dump, using this deployment's real unclaimed-prize deadline so the
      // number is never a guess.
      if (message.toLowerCase().includes("insufficient funds")) {
        setError(t("wheel.redeemInsufficientFunds", { days: unclaimedDeadlineDays }));
      } else if (message.toLowerCase().includes("rejected")) {
        // Keplr reports a plain "Request rejected" both when the player
        // declines to sign AND when it auto-blocks signing because the
        // wallet can't cover the network fee - there's no way to tell these
        // apart from here, so the message has to cover both honestly rather
        // than assume either one.
        setError(t("wheel.redeemRejectedOrFeeTooHigh"));
      } else {
        setError(message || t("wheel.actionFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  if (justRedeemed) {
    return <p className="round-status-note">{t("wheel.redeemedNote")}</p>;
  }

  return (
    <div className="redeem-box">
      <p className="round-status-note">{t("wheel.redeemHint")}</p>
      {balance.status === "loaded" && (
        <p className="redeem-balance-note">
          {t("wheel.redeemYourBalance", { amount: ulunaToDisplayNumber(balance.amount).toFixed(2) })}
        </p>
      )}
      <label className="redeem-amount-label" htmlFor={`redeem-amount-${roundId}`}>
        {t("wheel.redeemAmountLabel")}
      </label>
      <div className="redeem-amount-row">
        <input
          id={`redeem-amount-${roundId}`}
          type="number"
          min={0}
          max={prizeRemainingDisplay}
          step="0.01"
          value={amountValue}
          onChange={(e) => setAmountInput(e.target.value)}
          className="redeem-amount-input"
        />
        <button type="button" className="redeem-max-btn" onClick={() => setAmountInput(null)}>
          {t("wheel.redeemMax")}
        </button>
      </div>
      <p className="redeem-receive-note">
        {t("wheel.redeemReceiveNote", {
          send: amountValue || "0",
          receive: amountValid ? ulunaToDisplayNumber(amountUluna).toFixed(2) : "0.00",
        })}
      </p>
      <button className="round-action-btn" onClick={handleRedeem} disabled={busy || !amountValid}>
        {busy ? t("wheel.redeeming") : t("wheel.redeem")}
      </button>
      {error && <p className="round-action-error">{error}</p>}
    </div>
  );
}
