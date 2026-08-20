import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/onramp.css";
import { useAllBalances } from "../../hooks/useAllBalances";
import { microToDisplay } from "../../lib/onrampConfig";
import { fetchTokenPrices, priceForSymbol, type TokenPrices } from "../../lib/tokenPrices";
import { symbolForDenom, TREASURY_CHAINS, type TreasuryChain } from "../../lib/treasuryConfig";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type ChainReportStatus = "ok" | "partial" | "error";

// Lives in Shared/, rendered once from SocialLinks.tsx (App.tsx, outside
// <Routes>) so it's reachable from every page - not onramp-specific
// anymore, since Wheel of Repeg/Weekly Round/CYOL are all meant to feed
// this same treasury too, once redeployed with the real fee-keeper/
// treasury addresses (per direct request, 2026-08-19). Imports wheel.css/
// onramp.css itself (same pattern CyolVerifyPanel.tsx already uses for a
// sub-component reaching outside its own page's usual styles) so its
// classes resolve correctly no matter which page it's triggered from -
// onramp.css used to only load on the lazily-loaded /onramp route, which
// would have left this unstyled everywhere else.
//
// Live, on-chain balances - not a cached/self-reported number - same trust
// model as the rest of this site's public-verification panels (Verify this
// round, etc.): the user's own browser queries each chain's public LCD
// directly, so nobody has to take Repeg Club's word for what the treasury
// holds. The explorer link per chain is the fallback for anyone who wants
// to double-check this page's own query independently.
export function TreasuryPanel() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Same rotating-bubble pattern as VerifyRoundPanel's lab bubble - cycles
  // while the modal is open, resets to idle while it's closed.
  const BANK_BUBBLE_LINES = t("treasury.bankBubble", { returnObjects: true }) as string[];
  const [bankBubbleIndex, setBankBubbleIndex] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(
      () => setBankBubbleIndex((i) => (i + 1) % BANK_BUBBLE_LINES.length),
      8000
    );
    return () => clearInterval(id);
  }, [isOpen, BANK_BUBBLE_LINES.length]);

  // Prices fetched once per time the panel is opened (not on every page
  // load) - the estimated USD total is the only thing that needs them, and
  // it's meaningless while the modal is closed.
  const [prices, setPrices] = useState<TokenPrices | null>(null);
  const [pricesFailed, setPricesFailed] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setPrices(null);
    setPricesFailed(false);
    // Guards against a stale response landing after the panel closed and
    // reopened (open -> close -> reopen fast enough that the first fetch
    // is still in flight) - without this, that late response could
    // overwrite the second open's own state (found in CodeRabbit review,
    // PR #35).
    let active = true;
    fetchTokenPrices()
      .then((result) => {
        if (active) setPrices(result);
      })
      .catch(() => {
        if (active) setPricesFailed(true);
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  // Each TreasuryChainRow queries its own chain independently (own loading/
  // error state, doesn't block the others) but reports its USD subtotal up
  // here so the modal can show one combined estimate - lets each row stay a
  // self-contained component (same pattern as this site's other per-chain
  // rows, eg. DirectOriginForm) instead of hoisting all 4 useAllBalances
  // calls into this component keyed by array position. Each report also
  // carries a status - a chain whose balance query failed never used to
  // report anything at all, which left allChainsReported permanently false
  // and the total stuck on "Loading…" forever instead of surfacing the
  // failure (found in CodeRabbit review, PR #35). "partial" covers the
  // other gap the same review flagged: an unpriced denom is silently
  // skipped from that chain's own subtotal, so a chain can finish "ok" by
  // this component's bookkeeping while still under-counting.
  const [chainReports, setChainReports] = useState<Record<string, { status: ChainReportStatus; usd: number }>>({});
  const reportChain = useCallback((chainId: string, report: { status: ChainReportStatus; usd: number }) => {
    setChainReports((prev) => {
      const existing = prev[chainId];
      if (existing && existing.status === report.status && existing.usd === report.usd) return prev;
      return { ...prev, [chainId]: report };
    });
  }, []);
  useEffect(() => {
    if (!isOpen) setChainReports({});
  }, [isOpen]);

  const allChainsReported = TREASURY_CHAINS.every((c) => c.chainId in chainReports);
  const anyIncomplete = TREASURY_CHAINS.some((c) => chainReports[c.chainId]?.status !== "ok");
  const grandTotal = allChainsReported
    ? TREASURY_CHAINS.reduce((sum, c) => sum + (chainReports[c.chainId]?.usd ?? 0), 0)
    : null;

  // Same focus-trap/Escape/restore-focus pattern as OriginOptionsPanel.tsx -
  // duplicated rather than extracted into a shared modal component, same
  // call already made there (a shared modal component is a deferred, known
  // pending item - see the project notes on VerifyRoundPanel/
  // WeeklyVerifyRoundPanel's own duplication).
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

  return (
    <>
      {/* Icon button, same treatment as SocialLinks' whitepaper/Telegram/
          GitHub icons - unlike those 3 (self-explanatory logos), a bank
          icon alone doesn't obviously read as "treasury balance", so this
          one gets a real hover tooltip. A native `title` attribute does
          show one, but only after the browser/OS's own ~1s+ hover delay -
          too slow (reported live, 2026-08-19). .social-links-tooltip below
          is a plain CSS-only tooltip instead, with no built-in delay.
          aria-label stays regardless - that one's for screen readers, never
          shows anything visually either way. */}
      <button
        type="button"
        ref={triggerRef}
        className="social-links-icon social-links-icon-btn"
        aria-label={t("treasury.openButton")}
        onClick={() => setIsOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M11.5 1 2 6v2h19V6l-9.5-5ZM4 10v7h3v-7H4Zm6 0v7h3v-7h-3Zm6 0v7h3v-7h-3ZM2 19v3h19v-3H2Z" />
        </svg>
        <span className="social-links-tooltip" aria-hidden="true">
          {t("treasury.openButton")}
        </span>
      </button>
      {isOpen &&
        createPortal(
          <div className="verify-modal-backdrop" onClick={() => setIsOpen(false)}>
            <div
              className="verify-modal-outline pixel-stepped-corners"
              role="dialog"
              aria-modal="true"
              aria-labelledby="treasury-modal-title"
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
                      aria-label={t("treasury.close")}
                    >
                      &times;
                    </button>
                    <div className="verify-modal-header-wrap">
                      <img src="/characters/treasury-bank.jpg" alt="" className="verify-modal-header" />
                      {/* Estimated total, printed on the big empty RPC screen
                          in the image itself (same technique as .onramp-
                          banner-screen-text) instead of taking up modal-body
                          space below the chain list - so it's visible at a
                          glance without scrolling, per direct request. */}
                      <div className="treasury-screen-text">
                        <span className="treasury-screen-title">{t("treasury.screenTitle")}</span>
                        {grandTotal !== null ? (
                          <>
                            <span className="treasury-screen-label">{t("treasury.screenLabel")}</span>
                            <span className="treasury-screen-total">
                              <span className="treasury-screen-amount">{grandTotal.toFixed(2)}</span>
                              <span className="treasury-screen-currency">USDC</span>
                            </span>
                          </>
                        ) : pricesFailed ? (
                          <span className="treasury-screen-status">{t("treasury.pricesError")}</span>
                        ) : (
                          <span className="treasury-screen-status">{t("treasury.loading")}</span>
                        )}
                      </div>
                      <div className="treasury-bank-bubble-wrap">
                        <div className="host-guide-bubble-outline-rectangulo">
                          <div className="host-guide-bubble host-guide-bubble-rectangulo">
                            <p>{BANK_BUBBLE_LINES[bankBubbleIndex]}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                    <p id="treasury-modal-title" className="origin-options-modal-title">
                      {t("treasury.modalTitle")}
                    </p>
                    <p className="origin-option-note">{t("treasury.modalDesc")}</p>
                    <div className="treasury-chains-list">
                      {TREASURY_CHAINS.map((chain) => (
                        <TreasuryChainRow
                          key={chain.chainId}
                          chain={chain}
                          prices={prices}
                          onReport={reportChain}
                        />
                      ))}
                    </div>
                    {grandTotal !== null && anyIncomplete && (
                      <p className="treasury-total-note">{t("treasury.totalIncomplete")}</p>
                    )}
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

function TreasuryChainRow({
  chain,
  prices,
  onReport,
}: {
  chain: TreasuryChain;
  prices: TokenPrices | null;
  onReport: (chainId: string, report: { status: ChainReportStatus; usd: number }) => void;
}) {
  const { t } = useTranslation();
  const state = useAllBalances(chain.address, chain.lcd);

  useEffect(() => {
    // A failed balance query used to never report at all, leaving the
    // parent's "every chain reported" check permanently false and the
    // grand total stuck on "Loading…" - report it as $0/"error" instead,
    // so the total (and the incomplete-total note) can still render.
    if (state.status === "error") {
      onReport(chain.chainId, { status: "error", usd: 0 });
      return;
    }
    if (state.status !== "loaded" || !prices) return;
    let allPriced = true;
    const usd = state.balances.reduce((sum, b) => {
      const price = priceForSymbol(symbolForDenom(b.denom), prices);
      if (price === null) {
        allPriced = false;
        return sum;
      }
      return sum + microToDisplay(BigInt(b.amount)) * price;
    }, 0);
    onReport(chain.chainId, { status: allPriced ? "ok" : "partial", usd });
    // onReport is a stable useCallback from the parent - omitted here so
    // this doesn't re-run every render just because the parent re-created
    // an inline function (it doesn't, but this is the same defensive
    // pattern already used elsewhere in this project's hooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, prices, chain.chainId]);

  return (
    <div className="treasury-chain-row">
      <p className="treasury-chain-label">{chain.label}</p>
      {state.status === "loading" && <p className="treasury-chain-status">{t("treasury.loading")}</p>}
      {state.status === "error" && <p className="treasury-chain-status">{t("treasury.error")}</p>}
      {state.status === "loaded" &&
        (state.balances.length === 0 ? (
          <p className="treasury-chain-status">{t("treasury.empty")}</p>
        ) : (
          <ul className="treasury-balances">
            {state.balances.map((b) => {
              const symbol = symbolForDenom(b.denom);
              const amount = microToDisplay(BigInt(b.amount));
              const price = prices ? priceForSymbol(symbol, prices) : null;
              return (
                <li key={b.denom}>
                  {amount.toFixed(4)} {symbol}
                  {price !== null && (
                    <span className="treasury-balance-usd">
                      {" "}
                      (~${(amount * price).toFixed(2)})
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
      <a href={chain.explorerUrl} target="_blank" rel="noreferrer" className="treasury-explorer-link">
        {t("treasury.viewExplorer")} ↗
      </a>
    </div>
  );
}
