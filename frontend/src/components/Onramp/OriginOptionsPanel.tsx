import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Static reference data, not a live estimator - deliberately, per the
// project decision to skip building gas-cost calculation logic and just
// give the user the numbers already researched (Binance/KuCoin withdraw
// fees confirmed live in their apps; the Noble->Terra Classic hop
// cost/time measured in a real on-chain test). MEXC dropped 2026-08-18
// along with the whole EVM path (Ethereum/Arbitrum/Base) - its only
// viable route went via Arbitrum, which no longer exists as a supported
// origin here (see onrampConfig.ts).
const ORIGIN_OPTIONS = [
  { exchange: "Binance", path: "→ Noble", cost: "$5 min · $0.2 fee", time: "Near instant" },
  { exchange: "KuCoin", path: "→ Noble", cost: "$2 min · $1 fee", time: "Near instant" },
];

// Popup, not an inline reveal - a wide inline table read as out of place
// next to this page's other 480px-wide cards (reported live). Reuses the
// exact modal chrome already established by VerifyRoundPanel
// (.verify-modal-*), which is capped at 480px on its own, rather than
// inventing a new modal pattern.
export function OriginOptionsPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Escape to close, focus moved into the dialog on open and back to the
  // button that opened it on close, and Tab/Shift+Tab trapped inside while
  // it's open instead of escaping into the page behind - aria-modal="true"
  // alone doesn't do any of this by itself (found in review, 2026-08-17).
  useEffect(() => {
    if (!isOpen) return;
    // Captured now, not read again inside the cleanup below - by the time
    // that runs, .current may already point somewhere else (oxlint
    // react-hooks/exhaustive-deps flagged the original direct read).
    const trigger = triggerRef.current;
    const modal = modalRef.current;
    const focusables = modal?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    focusables?.[0]?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
        return;
      }
      if (e.key !== "Tab" || !focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [isOpen]);

  return (
    <div className="origin-options">
      <button
        type="button"
        ref={triggerRef}
        className="origin-options-btn"
        onClick={() => setIsOpen(true)}
      >
        Understand your options
      </button>
      {isOpen &&
        createPortal(
          <div className="verify-modal-backdrop" onClick={() => setIsOpen(false)}>
            <div
              className="verify-modal-outline pixel-stepped-corners"
              role="dialog"
              aria-modal="true"
              aria-labelledby="origin-options-modal-title"
              ref={modalRef}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="verify-modal-border pixel-stepped-corners">
                <div className="verify-modal-highlight pixel-stepped-corners">
                  <div className="verify-modal pixel-stepped-corners">
                    <button
                      type="button"
                      className="verify-modal-close"
                      onClick={() => setIsOpen(false)}
                      aria-label="Close"
                    >
                      &times;
                    </button>
                    <p id="origin-options-modal-title" className="origin-options-modal-title">
                      Understand your options
                    </p>
                    <div className="origin-options-list">
                      {ORIGIN_OPTIONS.map((o) => (
                        <div className="origin-option-row" key={o.exchange}>
                          <p className="origin-option-exchange">{o.exchange}</p>
                          <p className="origin-option-path">{o.path}</p>
                          <div className="origin-option-stats">
                            <span>{o.cost}</span>
                            <span>{o.time}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="origin-option-note">
                      Or choose the chain where you already have your funds — USDC, OSMO, or ATOM —
                      and just bring them in below.
                    </p>
                    <p className="origin-option-note">
                      Going the other way? Switch to "Send LUNC/USTC out" above to bridge straight
                      to BSC, Ethereum, or Solana via Hyperlane.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
