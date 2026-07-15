import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useBalance } from "../../hooks/useBalance";
import { sweepUstc } from "../../lib/roundActions";

type AdminSweepButtonProps = {
  adminAddress?: string;
  contractAddress?: string;
  redemptionDenom?: string;
};

// Only ever visible to the wallet that is this contract's `admin` (the
// deployer) - everyone else sees nothing here, not even a disabled button.
// SweepUstc is the only admin-gated action in wheel-manager/weekly-round
// (see security review, 2026-07-14): it can only push the contract's stray
// redemption_denom balance to the fixed treasury address, never redirect it
// elsewhere, so there's no user-input step here beyond a confirm click.
export function AdminSweepButton({ adminAddress, contractAddress, redemptionDenom }: AdminSweepButtonProps) {
  const { t } = useTranslation();
  const { state } = useWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"idle" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The contract's own balance, not the admin's - lets the button reflect
  // whether SweepUstc would actually move anything before it's clicked
  // (the contract itself no-ops and charges gas for nothing when it's zero).
  const contractBalance = useBalance(contractAddress ?? null, redemptionDenom);

  if (state.status !== "connected" || !adminAddress || state.address !== adminAddress) {
    return null;
  }

  const hasNothingToSweep = contractBalance.status === "loaded" && contractBalance.amount === "0";

  async function handleSweep() {
    if (state.status !== "connected") return;
    setBusy(true);
    setResult("idle");
    setErrorMessage(null);
    try {
      await sweepUstc(state.wallet, contractAddress);
      setResult("done");
      contractBalance.refetch();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("wheel.actionFailed"));
      setResult("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-sweep">
      <button className="wallet-connect-btn" onClick={handleSweep} disabled={busy || hasNothingToSweep}>
        {busy ? t("admin.sweeping") : hasNothingToSweep ? t("admin.sweepNothing") : t("admin.sweepButton")}
      </button>
      {result === "done" && <span className="admin-sweep-ok">{t("admin.sweepDone")}</span>}
      {result === "error" && <p className="round-action-error">{errorMessage}</p>}
    </div>
  );
}
