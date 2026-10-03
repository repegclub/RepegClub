import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatEther, type Hex } from "viem";
import { useEvmWallet } from "../../hooks/useEvmWallet";
import { useEvmBalances, useEvmInboundQuote } from "../../hooks/useEvmInboundData";
import { RATE_SCALE, useTerraBurnTaxRate } from "../../hooks/useTerraBurnTaxRate";
import {
  evmChainParamsFor,
  isUserRejection,
  quoteEvmInbound,
  sendEvmSupportTip,
  sendEvmToTerraClassic,
} from "../../lib/evmOnramp";
import { TxOutcomeUnknownError } from "../../lib/onrampActions";
import {
  EVM_SUPPORT_TIP,
  HYPERLANE_TERRA_CLASSIC_WARP,
  evmSupportTipAmount,
  availableHyperlaneAssets,
  displayToMicro,
  microToDisplay,
  type HyperlaneAsset,
  type HyperlaneDestination,
} from "../../lib/onrampConfig";

function truncate(address: string): string {
  return `${address.slice(0, 10)}...${address.slice(-4)}`;
}

function formatNative(wei: bigint): string {
  return Number(formatEther(wei)).toFixed(6);
}

// "Bring assets in" from an EVM chain (BSC/Ethereum) back to Terra Classic
// over the same Hyperlane routes the send-out leg uses - the mirror of
// DirectOutboundForm (DirectTransferCard.tsx). Signed by an EVM browser
// wallet (useEvmWallet), with every read from our own RPC. No Repeg Club
// fee on this leg yet: TERRA only pays Delfos' route fee (charged by the
// contract itself), and the voluntary LUNC/USTC fee is still undecided
// (project notes, 2026-10-03).
export function EvmInboundForm({
  origin,
  previewAssets,
  terraClassicAddressInput,
  onTerraClassicAddressInputChange,
  terraClassicAddress,
}: {
  origin: HyperlaneDestination;
  previewAssets: Set<string>;
  terraClassicAddressInput: string;
  onTerraClassicAddressInputChange: (value: string) => void;
  terraClassicAddress: string | null;
}) {
  const { t } = useTranslation();
  const params = evmChainParamsFor(origin.domain);
  const { providers, state: walletState, connect, disconnect } = useEvmWallet();
  const [pickerOpen, setPickerOpen] = useState(false);
  const account = walletState.status === "connected" ? walletState.address : null;

  const availableAssets = availableHyperlaneAssets(origin, previewAssets);
  const [assetSymbol, setAssetSymbol] = useState<HyperlaneAsset>(availableAssets[0]);
  const token = (origin.tokenAddress[assetSymbol] ?? null) as Hex | null;

  const [amountInput, setAmountInput] = useState("");
  const amountNumber = Number(amountInput);
  const amountRaw = displayToMicro(amountNumber);

  const balances = useEvmBalances(params, token, account);
  const quote = useEvmInboundQuote(params, token, amountRaw);
  // Only a quote for exactly what's typed now counts.
  const currentQuote = quote.status === "loaded" && quote.amount === amountRaw ? quote : null;
  const routeFee = currentQuote ? currentQuote.tokenTotal - amountRaw : 0n;
  // LUNC/USTC (native coins on Terra Classic) pay the chain's burn tax when
  // the route contract releases them; CW20s like TERRA arrive whole.
  const burnTax = useTerraBurnTaxRate();
  const assetTaxed = HYPERLANE_TERRA_CLASSIC_WARP[assetSymbol].kind === "native";
  const arriving =
    assetTaxed && burnTax.status === "loaded" ? amountRaw - (amountRaw * burnTax.rateE18) / RATE_SCALE : amountRaw;
  const taxPercent = burnTax.status === "loaded" ? (Number((burnTax.rateE18 * 10000n) / RATE_SCALE) / 100).toString() : "";

  // Optional 0.2% support payment (onrampConfig.ts's EVM_SUPPORT_TIP):
  // pre-checked where offered, always skippable.
  const tipOffered = EVM_SUPPORT_TIP.domains.includes(origin.domain) && EVM_SUPPORT_TIP.assets.includes(assetSymbol);
  const [tipChecked, setTipChecked] = useState(true);
  const tipActive = tipOffered && tipChecked;
  const tip = tipActive ? evmSupportTipAmount(amountRaw) : 0n;

  const [busy, setBusy] = useState(false);
  // Which wallet prompt is open while busy, so the two-signature flow says
  // which one the user is looking at.
  const [step, setStep] = useState<"tip" | "transfer" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [tipTxHash, setTipTxHash] = useState<string | null>(null);
  // Same reasoning as DirectOriginForm's outcomeUnknown (DirectTransferCard.
  // tsx): the tx was broadcast but its result couldn't be read, so retrying
  // could send twice. Always carries the hash to check here.
  const [outcomeUnknownTxHash, setOutcomeUnknownTxHash] = useState<string | null>(null);

  const destAddressInvalid = terraClassicAddressInput !== "" && terraClassicAddress === null;
  const tokenShort =
    balances.status === "loaded" && currentQuote !== null && currentQuote.tokenTotal + tip > balances.token;
  const nativeShort = balances.status === "loaded" && currentQuote !== null && balances.native < currentQuote.nativeGas;
  const amountValid =
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    amountRaw > 0n &&
    balances.status === "loaded" &&
    currentQuote !== null &&
    !tokenShort &&
    !nativeShort &&
    terraClassicAddress !== null;

  function resetResult() {
    setTxHash(null);
    setTipTxHash(null);
    setError(null);
  }

  function handleAssetChange(symbol: string) {
    if (!availableAssets.includes(symbol as HyperlaneAsset)) return;
    setAssetSymbol(symbol as HyperlaneAsset);
    setAmountInput("");
    resetResult();
    setOutcomeUnknownTxHash(null);
  }

  // The route fee (TERRA) comes out of the same balance, so Max is the
  // largest amount whose quoted total still fits - worked out from a quote
  // of the whole balance, then confirmed with a second quote.
  async function handleMax() {
    if (balances.status !== "loaded" || !token || balances.token === 0n) return;
    const zero: Hex = `0x${"00".repeat(32)}`;
    try {
      const full = await quoteEvmInbound(params, token, zero, balances.token);
      let candidate = balances.token - (full.tokenTotal - balances.token);
      if (candidate <= 0n) return;
      const check = await quoteEvmInbound(params, token, zero, candidate);
      if (check.tokenTotal > balances.token) candidate -= check.tokenTotal - balances.token;
      // Leave room for the support payment too, when it's on.
      if (tipActive) candidate = (candidate * 10000n) / (10000n + EVM_SUPPORT_TIP.bps);
      if (candidate > 0n) setAmountInput(microToDisplay(candidate).toString());
    } catch {
      setError(t("onramp.inbound.quoteError"));
    }
  }

  // viem errors carry a short, readable shortMessage (e.g. "User rejected
  // the request.") next to a long technical message.
  function errorMessage(err: unknown): string {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" ? short : err instanceof Error ? err.message : t("onramp.inbound.sendFailed");
  }

  async function handleSend() {
    if (walletState.status !== "connected" || !amountValid || !token || !terraClassicAddress) return;
    setBusy(true);
    setError(null);
    setTipTxHash(null);
    const provider = walletState.detail.provider;
    const account = walletState.address;
    if (tip > 0n) {
      setStep("tip");
      try {
        const paid = await sendEvmSupportTip({ provider, account, params, token, tip });
        setTipTxHash(paid.txHash);
        // Paid once - a retry after a failed transfer below mustn't ask for
        // it again.
        setTipChecked(false);
      } catch (err) {
        if (err instanceof TxOutcomeUnknownError) {
          // The payment may still land, and the balance is uncertain until it
          // does - stop here instead of signing the transfer on a guess.
          setOutcomeUnknownTxHash(err.txHash);
          setStep(null);
          setBusy(false);
          return;
        }
        // Declining the optional payment in the wallet is a "no thanks",
        // not a reason to stop. Any other failure means nothing was paid,
        // but stops so the user sees it and can uncheck the box.
        if (!isUserRejection(err)) {
          console.error(err);
          setError(errorMessage(err));
          setStep(null);
          setBusy(false);
          return;
        }
      }
    }
    setStep("transfer");
    try {
      const result = await sendEvmToTerraClassic({
        provider,
        account,
        params,
        asset: assetSymbol,
        token,
        amount: amountRaw,
        terraClassicAddress,
      });
      setTxHash(result.txHash);
      setAmountInput("");
      // Offered again (pre-checked) for the next transfer.
      setTipChecked(true);
      balances.refetch();
    } catch (err) {
      if (err instanceof TxOutcomeUnknownError) {
        setOutcomeUnknownTxHash(err.txHash);
      } else {
        console.error(err);
        setError(errorMessage(err));
      }
    } finally {
      setStep(null);
      setBusy(false);
    }
  }

  return (
    <div className="onramp-panel">
      <p className="onramp-panel-desc">{t("onramp.inbound.desc", { chain: origin.label })}</p>

      <select
        className="onramp-asset-select"
        value={assetSymbol}
        onChange={(e) => handleAssetChange(e.target.value)}
        aria-label={t("onramp.direct.assetSelectLabel")}
        disabled={busy}
      >
        {availableAssets.map((sym) => (
          <option key={sym} value={sym}>
            {sym}
          </option>
        ))}
      </select>

      {walletState.status === "connected" ? (
        <div className="onramp-wallet-row">
          <span className="onramp-wallet-dot" />
          <span className="onramp-wallet-address">{truncate(walletState.address)}</span>
          <button className="onramp-ghost-btn" onClick={disconnect} disabled={busy}>
            {t("wallet.disconnect")}
          </button>
        </div>
      ) : (
        <>
          <button
            className="onramp-main-btn"
            onClick={() => setPickerOpen((open) => !open)}
            disabled={walletState.status === "connecting"}
            aria-expanded={pickerOpen}
          >
            {walletState.status === "connecting"
              ? t("wallet.connecting")
              : t("onramp.inbound.connectButton", { chain: origin.label })}
          </button>
          {walletState.status === "error" && <p className="onramp-error-text">{walletState.message}</p>}
          {pickerOpen &&
            (providers.length === 0 ? (
              <p className="onramp-dest-warning">{t("onramp.inbound.noWallet")}</p>
            ) : (
              <div className="onramp-evm-wallets">
                {providers.map((p) => (
                  <button
                    key={p.info.uuid}
                    type="button"
                    className="onramp-ghost-btn onramp-evm-wallet-btn"
                    onClick={() => {
                      setPickerOpen(false);
                      connect(p);
                    }}
                  >
                    {p.info.icon && <img src={p.info.icon} alt="" width={18} height={18} />}
                    {p.info.name}
                  </button>
                ))}
              </div>
            ))}
          <p className="onramp-dest-warning">{t("onramp.inbound.mobileHint")}</p>
        </>
      )}

      {walletState.status === "connected" && (
        <>
          {balances.status === "loaded" && (
            <p className="onramp-balance-note">
              {t("onramp.inbound.balance", {
                amount: microToDisplay(balances.token).toFixed(2),
                symbol: assetSymbol,
                native: formatNative(balances.native),
                nativeSymbol: params.nativeSymbol,
              })}
            </p>
          )}
          {balances.status === "error" && (
            <p className="onramp-error-text">
              {t("onramp.inbound.balanceError")}{" "}
              <button type="button" className="onramp-ghost-btn" onClick={balances.refetch}>
                {t("onramp.outbound.gasPriceRetry")}
              </button>
            </p>
          )}

          <label className="onramp-field-label" htmlFor={`inbound-amount-${origin.domain}`}>
            {t("onramp.direct.amountLabel")}
          </label>
          <div className="onramp-input-row">
            <div className="onramp-input-wrap">
              <input
                id={`inbound-amount-${origin.domain}`}
                type="number"
                min={0}
                step="0.01"
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  resetResult();
                }}
                className="onramp-input"
                disabled={busy}
              />
              <span className="onramp-input-unit">{assetSymbol}</span>
            </div>
            {balances.status === "loaded" && (
              <button type="button" className="onramp-ghost-btn" onClick={handleMax} disabled={busy}>
                {t("wheel.redeemMax")}
              </button>
            )}
          </div>

          <label className="onramp-field-label" htmlFor={`inbound-address-${origin.domain}`}>
            {t("onramp.direct.destAddressLabel")}
          </label>
          <div className={"onramp-input-wrap" + (destAddressInvalid ? " onramp-dest-input-invalid" : "")}>
            <input
              id={`inbound-address-${origin.domain}`}
              type="text"
              placeholder={t("onramp.direct.destAddressPlaceholder")}
              value={terraClassicAddressInput}
              onChange={(e) => onTerraClassicAddressInputChange(e.target.value.trim())}
              className="onramp-input"
              disabled={busy}
            />
          </div>
          {destAddressInvalid ? (
            <p className="onramp-error-text">{t("onramp.direct.destAddressInvalid")}</p>
          ) : (
            <p className="onramp-dest-warning">{t("onramp.direct.destAddressWarning")}</p>
          )}

          {quote.status === "error" && (
            <p className="onramp-error-text">
              {t("onramp.inbound.quoteError")}{" "}
              <button type="button" className="onramp-ghost-btn" onClick={quote.refetch}>
                {t("onramp.outbound.gasPriceRetry")}
              </button>
            </p>
          )}
          {tokenShort && <p className="onramp-error-text">{t("onramp.inbound.tokenShort", { symbol: assetSymbol })}</p>}
          {nativeShort && currentQuote && (
            <p className="onramp-error-text">
              {t("onramp.inbound.gasNeeded", {
                amount: formatNative(currentQuote.nativeGas),
                symbol: params.nativeSymbol,
              })}
            </p>
          )}

          {tipOffered && (
            <label className="onramp-support-tip">
              <input
                type="checkbox"
                checked={tipChecked}
                onChange={(e) => setTipChecked(e.target.checked)}
                disabled={busy}
              />
              <span>
                {t("onramp.inbound.tipLabel", {
                  tip: amountRaw > 0n ? microToDisplay(evmSupportTipAmount(amountRaw)).toFixed(2) : "0.2%",
                  symbol: assetSymbol,
                })}
              </span>
            </label>
          )}

          {amountValid && currentQuote && (
            <p className="onramp-breakdown">
              {assetTaxed
                ? burnTax.status === "loaded"
                  ? t("onramp.inbound.breakdownTaxed", {
                      arrive: microToDisplay(arriving).toFixed(2),
                      symbol: assetSymbol,
                      taxPercent,
                      gas: formatNative(currentQuote.nativeGas),
                      nativeSymbol: params.nativeSymbol,
                      address: truncate(terraClassicAddress ?? ""),
                    })
                  : t("onramp.inbound.breakdownTaxUnknown", {
                      send: microToDisplay(amountRaw).toFixed(2),
                      symbol: assetSymbol,
                      gas: formatNative(currentQuote.nativeGas),
                      nativeSymbol: params.nativeSymbol,
                      address: truncate(terraClassicAddress ?? ""),
                    })
                : routeFee > 0n
                ? t("onramp.inbound.breakdownWithRouteFee", {
                    send: microToDisplay(amountRaw).toFixed(2),
                    routeFee: microToDisplay(routeFee).toFixed(4),
                    symbol: assetSymbol,
                    gas: formatNative(currentQuote.nativeGas),
                    nativeSymbol: params.nativeSymbol,
                    address: truncate(terraClassicAddress ?? ""),
                  })
                : t("onramp.inbound.breakdown", {
                    send: microToDisplay(amountRaw).toFixed(2),
                    symbol: assetSymbol,
                    gas: formatNative(currentQuote.nativeGas),
                    nativeSymbol: params.nativeSymbol,
                    address: truncate(terraClassicAddress ?? ""),
                  })}
            </p>
          )}

          <button
            className="onramp-main-btn onramp-send-btn"
            onClick={handleSend}
            disabled={busy || !amountValid || outcomeUnknownTxHash !== null}
          >
            {step === "tip"
              ? t("onramp.inbound.stepTip")
              : step === "transfer" && tipTxHash
              ? t("onramp.inbound.stepTransfer")
              : busy
              ? t("onramp.direct.sending")
              : t("onramp.direct.sendButton")}
          </button>
          {error && <p className="onramp-error-text">{error}</p>}
          {outcomeUnknownTxHash && (
            <div className="onramp-outcome-unknown">
              <p className="onramp-error-text">
                {t("onramp.direct.outcomeUnknownWithHash", { hash: outcomeUnknownTxHash })}
              </p>
              <button
                type="button"
                className="onramp-ghost-btn"
                onClick={() => {
                  setOutcomeUnknownTxHash(null);
                  balances.refetch();
                }}
              >
                {t("onramp.direct.outcomeUnknownAck")}
              </button>
            </div>
          )}
          {tipTxHash && (
            <p className="onramp-success-text">
              {t("onramp.inbound.tipPaid")}{" "}
              <a href={`${params.explorerTxUrl}${tipTxHash}`} target="_blank" rel="noreferrer">
                {truncate(tipTxHash)}
              </a>
            </p>
          )}
          {txHash && (
            <p className="onramp-success-text">
              {t("onramp.inbound.sent")}{" "}
              <a href={`${params.explorerTxUrl}${txHash}`} target="_blank" rel="noreferrer">
                {truncate(txHash)}
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
