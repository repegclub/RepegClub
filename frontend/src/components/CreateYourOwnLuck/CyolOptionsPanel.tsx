import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Same accessible-modal behavior as OriginOptionsPanel (Onramp) - focus
// moved into the dialog on open and back to the trigger on close, Tab/
// Shift+Tab trapped inside while open, Escape to close. Reuses the same
// .verify-modal-* chrome (wheel.css) rather than inventing a new modal.
export function CyolOptionsPanel() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
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

  // 4 core paths (free/paid x raffle/airdrop) plus the allowlist, which is
  // cross-cutting (layers onto any of the 4, not a 5th path of its own) -
  // rendered last and visually set apart rather than as a numbered 5th option.
  const blocks = [
    {
      key: "freeRaffle",
      bullets: ["freeRaffleBullet1", "freeRaffleBullet2", "freeRaffleBullet3"],
    },
    {
      key: "paidRaffle",
      bullets: ["paidRaffleBullet1", "paidRaffleBullet2", "paidRaffleBullet3"],
    },
    {
      key: "freeAirdrop",
      bullets: ["freeAirdropBullet1", "freeAirdropBullet2"],
    },
    {
      key: "paidAirdrop",
      bullets: ["paidAirdropBullet1", "paidAirdropBullet2"],
    },
  ];

  return (
    <div className="origin-options">
      <button
        type="button"
        ref={triggerRef}
        className="origin-options-btn"
        onClick={() => setIsOpen(true)}
      >
        {t("creatorTools.optionsGuide.trigger")}
      </button>
      {isOpen &&
        createPortal(
          <div className="verify-modal-backdrop" onClick={() => setIsOpen(false)}>
            <div
              className="verify-modal-outline pixel-stepped-corners"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cyol-options-modal-title"
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
                    <p id="cyol-options-modal-title" className="origin-options-modal-title">
                      {t("creatorTools.optionsGuide.title")}
                    </p>
                    <div className="cyol-options-list">
                      {blocks.map((block) => (
                        <div className="cyol-option-block" key={block.key}>
                          <p className="cyol-option-title">
                            {t(`creatorTools.optionsGuide.${block.key}Title`)}
                          </p>
                          <ul className="cyol-option-bullets">
                            {block.bullets.map((bulletKey) => (
                              <li key={bulletKey}>
                                {t(`creatorTools.optionsGuide.${bulletKey}`)}
                              </li>
                            ))}
                          </ul>
                          <p className="cyol-option-suggestion">
                            {t(`creatorTools.optionsGuide.${block.key}Suggestion`)}
                          </p>
                        </div>
                      ))}
                      <div className="cyol-option-block cyol-option-block-crosscutting">
                        <p className="cyol-option-title">
                          {t("creatorTools.optionsGuide.allowlistTitle")}
                        </p>
                        <ul className="cyol-option-bullets">
                          <li>{t("creatorTools.optionsGuide.allowlistBullet1")}</li>
                          <li>{t("creatorTools.optionsGuide.allowlistBullet2")}</li>
                        </ul>
                        <p className="cyol-option-suggestion">
                          {t("creatorTools.optionsGuide.allowlistSuggestion")}
                        </p>
                      </div>
                    </div>
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
