import { useState } from "react";
import { useTranslation } from "react-i18next";
import { buildVerificationPayload, verifyRound, type VerifyRoundResult } from "../../lib/verifyRound";

type VerifyRoundPanelProps = {
  roundId: number;
  contractAddress?: string;
};

type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; result: VerifyRoundResult }
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

export function VerifyRoundPanel({ roundId, contractAddress }: VerifyRoundPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const { copiedKey, copy } = useCopyable();

  async function handleVerify() {
    setState({ kind: "checking" });
    try {
      const result = await verifyRound(roundId, contractAddress);
      setState({ kind: "done", result });
    } catch {
      setState({ kind: "error" });
    }
  }

  return (
    <details className="verify-panel">
      <summary className="verify-summary">{t("verify.title")}</summary>
      <div className="verify-body">
        <p className="verify-intro">{t("verify.intro")}</p>
        <p className="verify-explanation">{t("verify.explanation")}</p>

        <div className="verify-round-id">
          <span>
            {t("verify.roundId")}: <strong>{roundId}</strong>
          </span>
          <button type="button" className="verify-copy-btn" onClick={() => copy("roundId", String(roundId))}>
            {copiedKey === "roundId" ? t("verify.copied") : t("verify.copy")}
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

        {state.kind === "error" && <p className="verify-result verify-result-error">{t("verify.error")}</p>}

        {state.kind === "done" && (
          <div className={`verify-result ${state.result.matches ? "verify-result-ok" : "verify-result-error"}`}>
            <p>{state.result.matches ? t("verify.matchTrue") : t("verify.matchFalse")}</p>
            <dl className="verify-details">
              <dt>{t("verify.drawHeight")}</dt>
              <dd>{state.result.drawHeight}</dd>
              <dt>{t("verify.blockTime")}</dt>
              <dd>{state.result.blockTimeIso}</dd>
              <dt>{t("verify.entrantsCount")}</dt>
              <dd>{state.result.entrants.length}</dd>
              <dt>{t("verify.drawGap")}</dt>
              <dd>{state.result.drawGap}</dd>
            </dl>
            <p className="verify-raw-caption">{t("verify.drawGapCaption")}</p>
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
                  copy("json", JSON.stringify(buildVerificationPayload(state.result), null, 2))
                }
              >
                {copiedKey === "json" ? t("verify.copied") : t("verify.copyJson")}
              </button>
              <p className="verify-raw-caption">{t("verify.copyJsonCaption")}</p>
            </div>
          </details>
        )}
      </div>
    </details>
  );
}
