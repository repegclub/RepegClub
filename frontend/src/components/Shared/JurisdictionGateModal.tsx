import { useState } from "react";
import { useTranslation } from "react-i18next";

// Shown once per browser (see jurisdictionGateCache.ts) before the first
// ticket purchase on any of the 3 products - Wheel of Repeg and Weekly
// Round both go through TicketBooth.tsx, Create Your Own Luck has its own
// buy flow in RaffleDetailPage.tsx. Same history-overlay/history-modal
// chrome as the other modals in this codebase (wheel.css), so it renders
// correctly from either call site without needing cyol.css, which isn't
// imported on the Wheel/Weekly pages.
export function JurisdictionGateModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  return (
    <div className="history-overlay" onClick={onCancel}>
      <div className="history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="history-modal-header">
          <h2 className="history-modal-title">{t("jurisdictionGate.title")}</h2>
          <button type="button" className="history-close-btn" onClick={onCancel}>
            ✕
          </button>
        </div>
        <p className="jurisdiction-gate-body">{t("jurisdictionGate.body")}</p>
        <label className="jurisdiction-gate-checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {t("jurisdictionGate.checkbox")}
        </label>
        <a
          href="/legal"
          target="_blank"
          rel="noopener noreferrer"
          className="jurisdiction-gate-link"
        >
          {t("jurisdictionGate.readFullTerms")}
        </a>
        <div className="jurisdiction-gate-actions">
          <button type="button" className="round-action-btn-secondary" onClick={onCancel}>
            {t("jurisdictionGate.cancel")}
          </button>
          <button type="button" className="round-action-btn" onClick={onConfirm} disabled={!checked}>
            {t("jurisdictionGate.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
