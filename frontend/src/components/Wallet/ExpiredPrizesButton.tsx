import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useExpiredPrizes, type ExpiredPrizeEntry } from "../../hooks/useExpiredPrizes";
import { sweepExpiredPrize, sweepExpiredWeekPrize } from "../../lib/roundActions";
import { formatUluna } from "../../lib/format";
import type { TierInfo } from "../../hooks/useWheelTiers";

type ExpiredPrizesButtonProps = {
  adminAddress?: string;
  tiers: TierInfo[];
};

type RowState = "idle" | "busy" | "done" | "error";

// Admin-only visibility, same gate as AdminSweepButton - but the underlying
// action is permissionless in the contract (see roundActions.ts). Restricting
// the button to admin here is a UI choice (this is an operational tool for
// handling support requests, not something a regular player needs), not a
// security boundary - anyone could still call SweepExpiredPrize directly.
export function ExpiredPrizesButton({ adminAddress, tiers }: ExpiredPrizesButtonProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const { state, load } = useExpiredPrizes();
  const [isOpen, setIsOpen] = useState(false);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  if (walletState.status !== "connected" || !adminAddress || walletState.address !== adminAddress) {
    return null;
  }

  function handleOpen() {
    setIsOpen(true);
    load();
  }

  function rowKey(entry: ExpiredPrizeEntry) {
    return `${entry.contractAddress}-${entry.id}`;
  }

  function tierLabel(entry: ExpiredPrizeEntry): string {
    if (entry.contractType === "weekly-round") return t("expiredPrizes.weeklyRoundLabel");
    const tier = tiers.find((tr) => tr.address === entry.contractAddress);
    const price = tier ? (Number(tier.ticketPrice) / 1_000_000).toFixed(2) : "?";
    return t("expiredPrizes.wheelManagerLabel", { price });
  }

  async function handleSweep(entry: ExpiredPrizeEntry) {
    if (walletState.status !== "connected") return;
    const key = rowKey(entry);
    setRowStates((prev) => ({ ...prev, [key]: "busy" }));
    try {
      if (entry.contractType === "wheel-manager") {
        await sweepExpiredPrize(walletState.wallet, entry.id, entry.contractAddress);
      } else {
        await sweepExpiredWeekPrize(walletState.wallet, entry.id, entry.contractAddress);
      }
      setRowStates((prev) => ({ ...prev, [key]: "done" }));
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : t("expiredPrizes.sweepFailed"),
      }));
      setRowStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  const entries = state.status === "loaded" ? state.entries : [];

  return (
    <>
      <button type="button" className="history-open-btn" onClick={handleOpen}>
        {t("expiredPrizes.open")}
      </button>
      {isOpen && (
        <div className="history-overlay" onClick={() => setIsOpen(false)}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="history-modal-header">
              <h2 className="history-modal-title">{t("expiredPrizes.title")}</h2>
              <button type="button" className="history-close-btn" onClick={() => setIsOpen(false)}>
                ✕
              </button>
            </div>

            <p className="round-status-note">{t("expiredPrizes.intro")}</p>

            {state.status === "loading" && <p className="round-status-note">{t("expiredPrizes.loading")}</p>}
            {state.status === "error" && <p className="round-action-error">{state.message}</p>}
            {state.status === "loaded" && entries.length === 0 && (
              <p className="round-status-note">{t("expiredPrizes.empty")}</p>
            )}

            {entries.length > 0 && (
              <ul className="history-list">
                {entries.map((entry) => {
                  const key = rowKey(entry);
                  const rowState = rowStates[key] ?? "idle";
                  return (
                    <li key={key} className="history-entry">
                      <span className="history-entry-round">
                        {tierLabel(entry)} ·{" "}
                        {entry.contractType === "wheel-manager"
                          ? t("expiredPrizes.roundLabel", { id: entry.id })
                          : t("expiredPrizes.weekLabel", { id: entry.id })}
                      </span>
                      <span className="history-entry-tickets">{formatUluna(entry.amount, "USDC")}</span>
                      <span className={entry.eligibleNow ? "history-won" : "history-outcome"}>
                        {entry.eligibleNow
                          ? t("expiredPrizes.eligibleNow")
                          : t("expiredPrizes.eligibleOn", {
                              date: new Date(entry.eligibleAtSeconds * 1000).toLocaleDateString(),
                            })}
                      </span>
                      {rowState === "done" ? (
                        <span className="admin-sweep-ok">{t("expiredPrizes.sweepDone")}</span>
                      ) : (
                        <button
                          type="button"
                          className="round-action-btn"
                          disabled={!entry.eligibleNow || rowState === "busy"}
                          onClick={() => handleSweep(entry)}
                        >
                          {rowState === "busy" ? t("expiredPrizes.sweeping") : t("expiredPrizes.sweepButton")}
                        </button>
                      )}
                      {rowState === "error" && <p className="round-action-error">{rowErrors[key]}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
