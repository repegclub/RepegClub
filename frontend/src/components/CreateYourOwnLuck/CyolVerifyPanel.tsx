import { useEffect, useState, type MouseEvent } from "react";
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
export function CyolVerifyPanel({ contractAddress, winnerAddress }: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txHashLoading, setTxHashLoading] = useState(true);
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const { copiedKey, copy } = useCopyable();

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
  // cancel those too).
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
        className="cyol-verify-open-btn"
        onClick={(e) => {
          e.preventDefault();
          setIsOpen(true);
        }}
      >
        {t("createYourOwnLuck.detail.verifyButton")}
      </button>

      {isOpen && (
        <div
          className="history-overlay"
          onClick={(e) => {
            e.preventDefault();
            setIsOpen(false);
          }}
        >
          <div className="history-modal" onClick={guardClick}>
            <div className="history-modal-header">
              <h2 className="history-modal-title">{t("verifyCyol.title")}</h2>
              <button type="button" className="history-close-btn" onClick={() => setIsOpen(false)}>
                ✕
              </button>
            </div>

            <p className="verify-intro">{t("verify.intro")}</p>
            <p className="verify-explanation">{t("verifyCyol.explanation")}</p>

            {state.kind !== "done" && (
              <button type="button" className="verify-check-btn" onClick={handleVerify} disabled={state.kind === "checking"}>
                {state.kind === "checking" ? t("verify.verifying") : t("verify.button")}
              </button>
            )}

            {state.kind === "error" && <p className="verify-result verify-result-error">{t("verify.error")}</p>}

            {state.kind === "done" && (
              <>
                <div className={`verify-result ${state.result.matches ? "verify-result-ok" : "verify-result-error"}`}>
                  <p>{state.result.matches ? t("verify.matchTrue") : t("verify.matchFalse")}</p>
                  <dl className="verify-details">
                    <dt>{t("verify.drawHeight")}</dt>
                    <dd>{state.result.drawHeight}</dd>
                    <dt>{t("verify.blockTime")}</dt>
                    <dd>{state.result.blockTimeIso}</dd>
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

                    <a className="verify-raw-link" href={state.result.blockQueryUrl} target="_blank" rel="noreferrer">
                      {t("verify.rawBlockLink")}
                    </a>
                    <p className="verify-raw-caption">{t("verify.rawBlockCaption")}</p>

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
      )}
    </div>
  );
}
