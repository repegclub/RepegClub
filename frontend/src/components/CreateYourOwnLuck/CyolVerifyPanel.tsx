import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { findPrizePayoutTxHash } from "../../lib/queryCyolDrawTx";
import { buildCyolVerificationPayload, verifyCyolRaffle, type VerifyCyolRaffleResult } from "../../lib/verifyCyolRaffle";

type Props = {
  contractAddress: string;
  winnerAddress: string;
};

type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; result: VerifyCyolRaffleResult }
  | { kind: "error" };

function useCopyable() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    });
  }
  return { copiedKey, copy };
}

// Winner + payout tx hash are shown to EVERY viewer of a drawn raffle, not
// just the winner - any participant should be able to confirm the prize
// really moved. The deep verification (recompute the winner from raw chain
// data) lives behind the "Verify" button in a popup instead of inline, so
// the card/page itself stays uncluttered for the common case of "just
// confirm it happened" - same split the user asked for explicitly
// (2026-07-23). Reused by both RaffleCard (the list) and RaffleDetailPage.
//
// The modal's own lab-panel visuals (header image + rotating lab-bubble
// lines) mirror Wheel of Repeg's VerifyRoundPanel/Weekly Round's
// WeeklyVerifyRoundPanel - this panel never got them (found live-testing,
// 2026-08-31), leaving the popup looking like an unfinished prototype next
// to the other 2 games'. The scientist+speech-bubble that sits next to
// THEIR open button is deliberately NOT copied here too - unlike those 2
// (one instance per page), this panel repeats once per card in a grid, and
// the scientist's absolute positioning (built for a single fixed spot)
// overlapped between cards when tried.
export function CyolVerifyPanel({ contractAddress, winnerAddress }: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txHashLoading, setTxHashLoading] = useState(true);
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const { copiedKey, copy } = useCopyable();

  const LAB_BUBBLE_LINES = t("verifyCyol.labBubble", { returnObjects: true }) as string[];
  const [labBubbleIndex, setLabBubbleIndex] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => setLabBubbleIndex((i) => (i + 1) % LAB_BUBBLE_LINES.length), 8000);
    return () => clearInterval(id);
  }, [isOpen, LAB_BUBBLE_LINES.length]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    let cancelled = false;
    setTxHashLoading(true);
    setTxHash(null);
    findPrizePayoutTxHash(contractAddress, winnerAddress).then((hash) => {
      if (!cancelled) {
        setTxHash(hash);
        setTxHashLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [contractAddress, winnerAddress]);

  async function handleVerify() {
    setState({ kind: "checking" });
    try {
      const result = await verifyCyolRaffle(contractAddress, winnerAddress);
      setState({ kind: "done", result });
    } catch {
      setState({ kind: "error" });
    }
  }

  // Both callers can render this inside a clickable <Link> card, and
  // nothing in here should trigger navigating to the detail page.
  // stopPropagation alone stops react-router's own onClick from firing
  // (avoiding a client-side navigate), but doesn't stop the browser's
  // native <a href> navigation: plain text/buttons have no default action
  // of their own, so a click on them falls back to the nearest ancestor
  // that does, which is the <a>. Blocking that needs preventDefault too -
  // except for the raw block/entrants links (.verify-raw-link specifically
  // - NOT a generic "a" selector, since that would also match the
  // surrounding card's own <a> and defeat this whole check) and the "show
  // everything" summary toggle, which each have their own legitimate
  // default action that must be allowed to run (preventDefault is a single
  // flag on the whole event, so calling it unconditionally here would
  // cancel those too). React's synthetic events bubble along the component
  // tree, not the DOM tree, so this still fires for clicks inside the
  // modal below even though createPortal renders it outside this div in
  // the actual DOM.
  function guardClick(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest("a.verify-raw-link, summary")) {
      e.preventDefault();
    }
    e.stopPropagation();
  }

  return (
    <div onClick={guardClick}>
      <p className="cyol-detail-hint">
        {t("createYourOwnLuck.detail.payoutTxLabel")}{" "}
        {txHashLoading
          ? t("createYourOwnLuck.detail.payoutTxLoading")
          : txHash
            ? txHash
            : t("createYourOwnLuck.detail.payoutTxNotFound")}
        {txHash && (
          <button type="button" className="cyol-inline-copy-btn" onClick={() => copy("tx", txHash)}>
            {copiedKey === "tx" ? t("verify.copied") : t("verify.copy")}
          </button>
        )}
      </p>

      <button
        type="button"
        className="cyol-submit cyol-submit-secondary cyol-verify-open-btn"
        onClick={(e) => {
          e.preventDefault();
          setIsOpen(true);
        }}
      >
        <span className="cyol-verify-btn-icon" aria-hidden="true" />
        {t("createYourOwnLuck.detail.verifyButton")}
      </button>

      {isOpen &&
        createPortal(
          <div
            className="verify-modal-backdrop"
            onClick={(e) => {
              e.preventDefault();
              setIsOpen(false);
            }}
          >
            <div
              className="verify-modal-outline pixel-stepped-corners"
              role="dialog"
              aria-modal="true"
              onClick={guardClick}
            >
              <div className="verify-modal-border pixel-stepped-corners">
                <div className="verify-modal-highlight pixel-stepped-corners">
                  <div className="verify-modal pixel-stepped-corners">
                    <button
                      type="button"
                      className="verify-modal-close"
                      onClick={() => setIsOpen(false)}
                      aria-label={t("verify.close")}
                    >
                      &times;
                    </button>
                    <div className="verify-modal-header-wrap">
                      <img src="/characters/verify-lab-panel.png" alt="" className="verify-modal-header" />
                      <img src="/brand/isotipo-pixel-art.png" alt="" className="wheel-booth-logo wheel-booth-logo-left" />
                      <div className="verify-lab-bubble-wrap">
                        <div className="host-guide-bubble-outline-rectangulo">
                          <div className="host-guide-bubble host-guide-bubble-rectangulo">
                            <p>{LAB_BUBBLE_LINES[labBubbleIndex]}</p>
                          </div>
                        </div>
                        <div className="host-guide-bubble-tail host-guide-bubble-tail-1" />
                        <div className="host-guide-bubble-tail host-guide-bubble-tail-2" />
                      </div>
                    </div>
                    <div className="verify-modal-body">
                      <p className="verify-intro">{t("verify.intro")}</p>
                      <p className="verify-explanation">{t("verifyCyol.explanation")}</p>

                      {state.kind !== "done" && (
                        <button
                          type="button"
                          className="verify-check-btn"
                          onClick={handleVerify}
                          disabled={state.kind === "checking"}
                        >
                          {state.kind === "checking" ? t("verify.verifying") : t("verify.button")}
                        </button>
                      )}

                      {state.kind === "error" && <p className="verify-result verify-result-error">{t("verify.error")}</p>}

                      {state.kind === "done" && (
                        <>
                          <div className={`verify-result ${state.result.matches ? "verify-result-ok" : "verify-result-error"}`}>
                            <p>{state.result.matches ? t("verify.matchTrue") : t("verify.matchFalse")}</p>
                            <dl className="verify-details">
                              <dt>{t("verify.commitUsed")}</dt>
                              <dd className="verify-mono-wrap">{state.result.commitUsedHex}</dd>
                              <dt>{t("verify.revealedPreimage")}</dt>
                              <dd className="verify-mono-wrap">{state.result.preimageHex}</dd>
                              <dt>{t("verify.entrantsCount")}</dt>
                              <dd>{state.result.entrants.length}</dd>
                            </dl>
                          </div>

                          <details className="verify-advanced">
                            <summary>{t("verify.advancedTitle")}</summary>
                            <div className="verify-advanced-body">
                              <p className="verify-raw-caption">{t("verify.advancedIntro")}</p>

                              <p className="verify-advanced-label">{t("verify.entrantsList")}</p>
                              <ul className="verify-entrants-list">
                                {state.result.entrants.map((addr, i) => (
                                  <li key={`${addr}-${i}`} className={i === state.result.winnerIndex ? "verify-winner-row" : ""}>
                                    {addr}
                                  </li>
                                ))}
                              </ul>

                              <dl className="verify-details">
                                <dt>{t("verify.digest")}</dt>
                                <dd className="verify-mono-wrap">{state.result.digestHex}</dd>
                                <dt>{t("verify.winnerIndex")}</dt>
                                <dd>{state.result.winnerIndex}</dd>
                              </dl>

                              <a className="verify-raw-link" href={state.result.entrantsQueryUrl} target="_blank" rel="noreferrer">
                                {t("verify.rawEntrantsLink")}
                              </a>
                              <p className="verify-raw-caption">{t("verify.rawEntrantsCaption")}</p>

                              <button
                                type="button"
                                className="verify-copy-btn verify-copy-json-btn"
                                onClick={() =>
                                  copy("json", JSON.stringify(buildCyolVerificationPayload(contractAddress, state.result), null, 2))
                                }
                              >
                                {copiedKey === "json" ? t("verify.copied") : t("verify.copyJson")}
                              </button>
                              <p className="verify-raw-caption">{t("verifyCyol.copyJsonCaption")}</p>
                            </div>
                          </details>
                        </>
                      )}
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
