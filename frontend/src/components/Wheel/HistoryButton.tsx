import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useWalletHistory } from "../../hooks/useWalletHistory";
import { ulunaToDisplayNumber } from "../../lib/format";
import type { TierInfo } from "../../hooks/useWheelTiers";

type HistoryButtonProps = {
  // For labeling which tier each entry belongs to - round_ids repeat across
  // tiers, so "#1" alone is ambiguous once history spans more than one.
  tiers: TierInfo[];
};

// A button + popup rather than an always-visible section, deliberately - a
// full round-by-round history grows unbounded over time and would otherwise
// permanently eat a large chunk of the page.
export function HistoryButton({ tiers }: HistoryButtonProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const { state, open, loadMore } = useWalletHistory(address);
  const [isOpen, setIsOpen] = useState(false);

  function tierLabel(contractAddress: string): string {
    const tier = tiers.find((t) => t.address === contractAddress);
    return tier ? `${ulunaToDisplayNumber(tier.ticketPrice).toFixed(2)} USDC` : "";
  }

  if (!address) return null;

  function handleOpen() {
    setIsOpen(true);
    open();
  }

  const entries = state.status === "idle" ? [] : state.entries;

  return (
    <>
      <button type="button" className="history-open-btn" onClick={handleOpen}>
        {t("history.open")}
      </button>
      {isOpen && (
        <div className="history-overlay" onClick={() => setIsOpen(false)}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="history-modal-header">
              <h2 className="history-modal-title">{t("history.title")}</h2>
              <button type="button" className="history-close-btn" onClick={() => setIsOpen(false)}>
                ✕
              </button>
            </div>

            {state.status === "loading" && entries.length === 0 && (
              <p className="round-status-note">{t("history.loading")}</p>
            )}
            {state.status === "error" && <p className="round-action-error">{state.message}</p>}
            {state.status !== "loading" && state.status !== "error" && entries.length === 0 && (
              <p className="round-status-note">{t("history.empty")}</p>
            )}

            {entries.length > 0 && (
              <ul className="history-list">
                {entries.map((entry) => (
                  <li key={`${entry.contractAddress}-${entry.round_id}`} className="history-entry">
                    <span className="history-entry-round">
                      {tierLabel(entry.contractAddress)} · #{entry.round_id}
                    </span>
                    <span className="history-entry-tickets">
                      {t("entrants.ticket", { count: entry.ticket_count })}
                    </span>
                    <span className={entry.won ? "history-won" : "history-outcome"}>
                      {entry.status === "expired"
                        ? t("history.expired")
                        : entry.won
                          ? t("history.won", { amount: ulunaToDisplayNumber(entry.prize_amount).toFixed(2) })
                          : t("history.lost")}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {state.status === "loading" && entries.length > 0 && (
              <p className="round-status-note">{t("history.loading")}</p>
            )}
            {state.status === "loaded" && state.hasMore && (
              <button type="button" className="round-action-btn" onClick={loadMore}>
                {t("history.loadMore")}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
