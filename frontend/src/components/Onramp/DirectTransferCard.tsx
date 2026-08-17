import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Widget } from "@skip-go/widget";
import { useCosmosWallet } from "../../hooks/useCosmosWallet";
import { useBalance } from "../../hooks/useBalance";
import { isValidTerraClassicAddress, sendDirectToTerraClassic } from "../../lib/onrampActions";
import {
  DIRECT_ORIGIN_CHAINS,
  ONRAMP_CHAIN_AFFILIATES,
  ONRAMP_DEFAULT_ROUTE,
  ONRAMP_FILTER,
  ONRAMP_THEME,
  displayToMicro,
  getDirectFeeSplit,
  microToDisplay,
  type DirectOriginAsset,
  type DirectOriginChain,
} from "../../lib/onrampConfig";

function truncate(address: string): string {
  return `${address.slice(0, 10)}...${address.slice(-4)}`;
}

// One card, one selector, one panel underneath that swaps content - the
// unifying design decided 2026-08-15: Noble/Cosmos Hub/Osmosis sign
// themselves (see onrampActions.ts), Ethereum/Arbitrum/Base still need the
// Skip Go widget (no EVM wallet integration of our own yet). The seam
// between those two engines is deliberately invisible - same tab row,
// same rounded "widget-style" panel chrome for both (onramp.css), pixel
// art only on the outer frame in OnrampPage.tsx. Nothing here decides
// which engine "looks more like the site" - the goal is the opposite: the
// direct-transfer form matches the embedded widget's own look, not the
// other way around, since the widget's Shadow DOM can't be pixel-arted
// (see ONRAMP_THEME's own comments on that constraint).
export function DirectTransferCard() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<DirectOriginChain | "other">(DIRECT_ORIGIN_CHAINS[0]);
  // Lifted up here (not local to DirectOriginForm) so it survives
  // switching between the Noble/Cosmos Hub/Osmosis tabs - the destination
  // is the same address no matter which origin tab is active, the user
  // shouldn't have to paste it again per tab. Pasted, not derived - see
  // isValidTerraClassicAddress in onrampActions.ts for why.
  const [terraClassicAddressInput, setTerraClassicAddressInput] = useState("");
  const terraClassicAddressValid = isValidTerraClassicAddress(terraClassicAddressInput);

  return (
    <div className="onramp-tool-panel">
      <div className="onramp-tabs" role="tablist">
        {DIRECT_ORIGIN_CHAINS.map((chain) => (
          <button
            key={chain.chainId}
            type="button"
            role="tab"
            aria-selected={selected !== "other" && selected.chainId === chain.chainId}
            className={
              "onramp-tab" + (selected !== "other" && selected.chainId === chain.chainId ? " onramp-tab-active" : "")
            }
            onClick={() => setSelected(chain)}
          >
            {chain.label}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={selected === "other"}
          className={"onramp-tab" + (selected === "other" ? " onramp-tab-active" : "")}
          onClick={() => setSelected("other")}
        >
          {t("onramp.otherChainsTab")}
        </button>
      </div>

      {selected === "other" ? (
        <Widget
          theme={ONRAMP_THEME}
          defaultRoute={ONRAMP_DEFAULT_ROUTE}
          filter={ONRAMP_FILTER}
          chainIdsToAffiliates={ONRAMP_CHAIN_AFFILIATES}
        />
      ) : (
        <DirectOriginForm
          key={selected.chainId}
          chain={selected}
          terraClassicAddressInput={terraClassicAddressInput}
          onTerraClassicAddressInputChange={setTerraClassicAddressInput}
          terraClassicAddress={terraClassicAddressValid ? terraClassicAddressInput : null}
        />
      )}
    </div>
  );
}

function DirectOriginForm({
  chain,
  terraClassicAddressInput,
  onTerraClassicAddressInputChange,
  terraClassicAddress,
}: {
  chain: DirectOriginChain;
  terraClassicAddressInput: string;
  onTerraClassicAddressInputChange: (value: string) => void;
  terraClassicAddress: string | null;
}) {
  const { t } = useTranslation();
  const { state: walletState, connect, disconnect } = useCosmosWallet(chain);
  const address = walletState.status === "connected" ? walletState.address : null;
  const destAddressInvalid = terraClassicAddressInput !== "" && terraClassicAddress === null;
  // Noble only ever has one asset (its native token already is USDC).
  // Cosmos Hub/Osmosis each offer their native token or USDC already
  // sitting on that chain - same direct-transfer mechanism either way
  // (onrampActions.ts doesn't care whether a swap is involved), just a
  // different source denom.
  const [asset, setAsset] = useState<DirectOriginAsset>(chain.assets[0]);
  const balance = useBalance(address, asset.denom, chain.lcd);
  // Only meaningfully different from `balance` above when the selected
  // asset ISN'T the chain's own gas denom (USDC on Cosmos Hub/Osmosis,
  // sending their native ATOM/OSMO instead) - gas for that tx still comes
  // out of the native token, which the asset balance above says nothing
  // about. Without this, the wallet could hold plenty of USDC and still
  // have the signed tx fail at broadcast for lack of gas (found in
  // review, 2026-08-17).
  const gasIsSameDenom = asset.denom === chain.gasPrice.denom;
  const gasBalance = useBalance(gasIsSameDenom ? null : address, chain.gasPrice.denom, chain.lcd);
  const hasGasForFee =
    gasIsSameDenom || (gasBalance.status === "loaded" && BigInt(gasBalance.amount) >= chain.maxGasReserve);
  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Set instead of a normal retryable error when broadcastTxSync itself
  // throws a TypeError (see handleSend below) - that can mean the tx never
  // reached the chain, but it can also mean it DID land and only the
  // response parsing afterward failed, which this project can't tell
  // apart from here. Blocks Send until the user explicitly acknowledges
  // they've checked their wallet/an explorer first, instead of silently
  // re-enabling retry and risking a duplicate transfer + duplicate fee
  // (found in review, 2026-08-17).
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);

  const amountNumber = Number(amountInput);
  // Comparing in raw integer micro-units (not the rounded display string)
  // against the raw balance - a display-rounded amount can round up past
  // what's actually available.
  const amountRaw = displayToMicro(amountNumber);
  const amountValid =
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    // A tiny-enough display amount rounds down to 0n in displayToMicro
    // (e.g. under 0.0000005) while amountNumber > 0 above still passes -
    // checked separately so a dust input can't slip through as a
    // zero-value transfer (found in review, 2026-08-17).
    amountRaw > 0n &&
    balance.status === "loaded" &&
    amountRaw <= BigInt(balance.amount) &&
    // When the asset being sent IS the gas denom, hasGasForFee above is
    // always true regardless of amount - it only checks the SEPARATE gas
    // balance, which doesn't apply here. The Max button already reserves
    // maxGasReserve (see handleMax), but a manually typed amount equal to
    // the full balance wasn't checked the same way, and would pass
    // validation only to fail at broadcast for lack of gas (found in
    // review, 2026-08-17).
    (!gasIsSameDenom || amountRaw + chain.maxGasReserve <= BigInt(balance.amount)) &&
    hasGasForFee &&
    terraClassicAddress !== null;
  const { transferAmount, treasuryAmount, feeKeeperAmount } = getDirectFeeSplit(chain.chainId, amountRaw);

  function handleAssetChange(denom: string) {
    const next = chain.assets.find((a) => a.denom === denom);
    if (!next) return;
    setAsset(next);
    setAmountInput("");
    setTxHash(null);
    setError(null);
    setOutcomeUnknown(false);
  }

  function handleMax() {
    if (balance.status !== "loaded") return;
    const raw = BigInt(balance.amount);
    // Only reserve gas headroom when the asset being sent IS the chain's
    // gas denom - a USDC balance on Cosmos Hub/Osmosis doesn't need any
    // of itself held back for gas (gas comes out of ATOM/OSMO instead).
    const reserve = asset.denom === chain.gasPrice.denom ? chain.maxGasReserve : 0n;
    const max = raw > reserve ? raw - reserve : 0n;
    setAmountInput(microToDisplay(max).toString());
  }

  async function handleSend() {
    if (walletState.status !== "connected" || !amountValid || !terraClassicAddress) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendDirectToTerraClassic(
        walletState.wallet,
        chain,
        asset,
        amountRaw,
        terraClassicAddress
      );
      setTxHash(result.res.txResponse.txhash);
      setAmountInput("");
      balance.refetch();
    } catch (err) {
      // TypeError is-an Error, so it used to fall through to err.message
      // below and surface cosmes' raw "Cannot destructure property 'code'
      // of ... as it is undefined" (RpcClient.js) straight to the user -
      // that's what a flaky public RPC's malformed broadcast_tx_sync
      // response looks like from here, not a real message meant for
      // display (found in review, 2026-08-16). That first sighting was
      // confirmed live to be pre-broadcast, but a TypeError here can't be
      // told apart in general from the tx actually landing and only the
      // response parsing afterward failing - so this no longer treats it
      // as a plain retryable network error (found in review, 2026-08-17).
      // Every deliberate throw in this file/onrampActions.ts is a plain
      // Error, so this still shows the real reason for anything we threw
      // on purpose.
      if (err instanceof TypeError) {
        console.error(err);
        setOutcomeUnknown(true);
      } else {
        setError(err instanceof Error ? err.message : t("onramp.direct.sendFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onramp-panel">
      <p className="onramp-panel-desc">{t("onramp.direct.desc", { chain: chain.label })}</p>

      {chain.assets.length > 1 && (
        <select
          className="onramp-asset-select"
          value={asset.denom}
          onChange={(e) => handleAssetChange(e.target.value)}
          aria-label={t("onramp.direct.assetSelectLabel")}
        >
          {chain.assets.map((a) => (
            <option key={a.denom} value={a.denom}>
              {a.symbol}
            </option>
          ))}
        </select>
      )}

      {walletState.status === "connected" ? (
        <div className="onramp-wallet-row">
          <span className="onramp-wallet-dot" />
          <span className="onramp-wallet-address">{truncate(walletState.address)}</span>
          <button className="onramp-ghost-btn" onClick={disconnect}>
            {t("wallet.disconnect")}
          </button>
        </div>
      ) : walletState.status === "error" ? (
        <div className="onramp-wallet-row onramp-wallet-row-error">
          <span className="onramp-error-text">{t(`wallet.${walletState.kind}`)}</span>
          {walletState.kind === "notInstalled" ? (
            <a className="onramp-main-btn" href="https://www.keplr.app/" target="_blank" rel="noreferrer">
              {t("wallet.install")}
            </a>
          ) : (
            <button className="onramp-main-btn" onClick={connect}>
              {t("wallet.retry")}
            </button>
          )}
        </div>
      ) : (
        <button className="onramp-main-btn" onClick={connect} disabled={walletState.status === "connecting"}>
          {walletState.status === "connecting"
            ? t("wallet.connecting")
            : t("onramp.direct.connectButton", { chain: chain.label })}
        </button>
      )}

      {walletState.status === "connected" && (
        <>
          {balance.status === "loaded" && (
            <p className="onramp-balance-note">
              {asset.symbol === "USDC"
                ? t("onramp.direct.balanceUsdc", {
                    amount: microToDisplay(BigInt(balance.amount)).toFixed(2),
                    chain: chain.label,
                  })
                : t("onramp.direct.balance", {
                    amount: microToDisplay(BigInt(balance.amount)).toFixed(2),
                    symbol: asset.symbol,
                  })}
            </p>
          )}
          <label className="onramp-field-label" htmlFor={`direct-amount-${chain.chainId}`}>
            {t("onramp.direct.amountLabel")}
          </label>
          <div className="onramp-input-row">
            <div className="onramp-input-wrap">
              <input
                id={`direct-amount-${chain.chainId}`}
                type="number"
                min={0}
                step="0.01"
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  setTxHash(null);
                }}
                className="onramp-input"
              />
              <span className="onramp-input-unit">{asset.symbol}</span>
            </div>
            {balance.status === "loaded" && (
              <button type="button" className="onramp-ghost-btn" onClick={handleMax}>
                {t("wheel.redeemMax")}
              </button>
            )}
          </div>

          <label className="onramp-field-label" htmlFor={`direct-address-${chain.chainId}`}>
            {t("onramp.direct.destAddressLabel")}
          </label>
          <div className={"onramp-input-wrap" + (destAddressInvalid ? " onramp-dest-input-invalid" : "")}>
            <input
              id={`direct-address-${chain.chainId}`}
              type="text"
              placeholder={t("onramp.direct.destAddressPlaceholder")}
              value={terraClassicAddressInput}
              onChange={(e) => onTerraClassicAddressInputChange(e.target.value.trim())}
              className="onramp-input"
            />
          </div>
          {destAddressInvalid ? (
            <p className="onramp-error-text">{t("onramp.direct.destAddressInvalid")}</p>
          ) : (
            <p className="onramp-dest-warning">{t("onramp.direct.destAddressWarning")}</p>
          )}

          {!gasIsSameDenom && gasBalance.status === "loaded" && !hasGasForFee && (
            <p className="onramp-error-text">
              {t("onramp.direct.gasNeeded", { symbol: chain.assets[0].symbol })}
            </p>
          )}

          {amountValid && (
            <p className="onramp-breakdown">
              {t("onramp.direct.breakdown", {
                fee: microToDisplay(treasuryAmount + feeKeeperAmount).toFixed(4),
                symbol: asset.symbol,
                send: microToDisplay(transferAmount).toFixed(2),
                address: terraClassicAddress ? truncate(terraClassicAddress) : "",
              })}
            </p>
          )}

          <button
            className="onramp-main-btn onramp-send-btn"
            onClick={handleSend}
            disabled={busy || !amountValid || outcomeUnknown}
          >
            {busy ? t("onramp.direct.sending") : t("onramp.direct.sendButton")}
          </button>
          {error && <p className="onramp-error-text">{error}</p>}
          {outcomeUnknown && (
            <div className="onramp-outcome-unknown">
              <p className="onramp-error-text">{t("onramp.direct.outcomeUnknown")}</p>
              <button
                type="button"
                className="onramp-ghost-btn"
                onClick={() => {
                  setOutcomeUnknown(false);
                  balance.refetch();
                }}
              >
                {t("onramp.direct.outcomeUnknownAck")}
              </button>
            </div>
          )}
          {txHash && <p className="onramp-success-text">{t("onramp.direct.sent", { hash: txHash })}</p>}
        </>
      )}
    </div>
  );
}
