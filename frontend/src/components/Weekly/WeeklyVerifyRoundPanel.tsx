import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  buildWeeklyVerificationPayload,
  verifyWeeklyRound,
  type VerifyWeeklyRoundResult,
} from "../../lib/verifyWeeklyRound";

type WeeklyVerifyRoundPanelProps = {
  weekId: number;
  contractAddress?: string;
};

type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; result: VerifyWeeklyRoundResult }
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

// Same panel as Wheel of Repeg's VerifyRoundPanel, just pointed at Weekly
// Round's own query/hash shape (week_id instead of round_id). Duplicated
// rather than made generic - it's presentational, two call sites don't
// justify a shared abstraction, and keeping them separate means a future
// change to one game's verification UI can't accidentally break the other's.
export function WeeklyVerifyRoundPanel({ weekId, contractAddress }: WeeklyVerifyRoundPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const [isOpen, setIsOpen] = useState(false);
  const { copiedKey, copy } = useCopyable();

  const LAB_BUBBLE_LINES = t("verifyWeekly.labBubble", { returnObjects: true }) as string[];
  const [labBubbleIndex, setLabBubbleIndex] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(
      () => setLabBubbleIndex((i) => (i + 1) % LAB_BUBBLE_LINES.length),
      8000
    );
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

  async function handleVerify() {
    setState({ kind: "checking" });
    try {
      const result = await verifyWeeklyRound(weekId, contractAddress);
      setState({ kind: "done", result });
    } catch {
      setState({ kind: "error" });
    }
  }

  return (
    <>
      <div className="verify-scientist-wrap">
        <div className="verify-speech-bubble-wrap">
          <img src="/characters/globo-horizontal.png" alt="" className="verify-speech-bubble-img" />
          <p className="verify-speech-bubble-text">
            {t("verifyWeekly.speechBubble").split("\n").map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </p>
        </div>
        <img src="/characters/scientist.png" alt="" className="verify-scientist" />
        <button type="button" className="verify-open-btn" onClick={() => setIsOpen(true)}>
          {t("verifyWeekly.title").split("\n").map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </button>
      </div>
      {isOpen && createPortal(
        <div className="verify-modal-backdrop" onClick={() => setIsOpen(false)}>
          <div
            className="verify-modal-outline pixel-stepped-corners"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
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
                    <p className="verify-explanation">{t("verifyWeekly.explanation")}</p>

                    <div className="verify-round-id">
                      <span>
                        {t("verifyWeekly.weekId")}: <strong>{weekId}</strong>
                      </span>
                      <button
                        type="button"
                        className="verify-copy-btn"
                        onClick={() => copy("weekId", String(weekId))}
                      >
                        {copiedKey === "weekId" ? t("verify.copied") : t("verify.copy")}
                      </button>
                    </div>

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

                    {state.kind === "error" && (
                      <p className="verify-result verify-result-error">{t("verify.error")}</p>
                    )}

                    {state.kind === "done" && (
                      <div
                        className={`verify-result ${state.result.matches ? "verify-result-ok" : "verify-result-error"}`}
                      >
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
                    )}

                    {state.kind === "done" && (
                      <details className="verify-advanced">
                        <summary>{t("verify.advancedTitle")}</summary>
                        <div className="verify-advanced-body">
                          <p className="verify-raw-caption">{t("verify.advancedIntro")}</p>

                          <p className="verify-advanced-label">{t("verify.entrantsList")}</p>
                          <ul className="verify-entrants-list">
                            {state.result.entrants.map((addr, i) => (
                              <li
                                key={`${addr}-${i}`}
                                className={i === state.result.winnerIndex ? "verify-winner-row" : ""}
                              >
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

                          <a
                            className="verify-raw-link"
                            href={state.result.entrantsQueryUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("verify.rawEntrantsLink")}
                          </a>
                          <p className="verify-raw-caption">{t("verify.rawEntrantsCaption")}</p>

                          <button
                            type="button"
                            className="verify-copy-btn verify-copy-json-btn"
                            onClick={() =>
                              copy("json", JSON.stringify(buildWeeklyVerificationPayload(state.result), null, 2))
                            }
                          >
                            {copiedKey === "json" ? t("verify.copied") : t("verify.copyJson")}
                          </button>
                          <p className="verify-raw-caption">{t("verifyWeekly.copyJsonCaption")}</p>
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
