import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WalletProviderPopover } from "../Wallet/WalletProviderPopover";
import { useCosmosWallet } from "../../hooks/useCosmosWallet";
import { useBalance } from "../../hooks/useBalance";
import {
  isValidEvmAddress,
  isValidSolanaAddress,
  isValidTerraClassicAddress,
  sendDirectToTerraClassic,
  sendOutViaHyperlane,
} from "../../lib/onrampActions";
import { WALLET_PROVIDERS } from "../../lib/walletProviders";
import {
  DIRECT_ORIGIN_CHAINS,
  HYPERLANE_DESTINATIONS,
  HYPERLANE_TERRA_CLASSIC_WARP,
  TERRA_CLASSIC_MAINNET,
  displayToMicro,
  getDirectFeeSplit,
  microToDisplay,
  type DirectOriginAsset,
  type DirectOriginChain,
  type HyperlaneAsset,
  type HyperlaneDestination,
} from "../../lib/onrampConfig";

function truncate(address: string): string {
  return `${address.slice(0, 10)}...${address.slice(-4)}`;
}

// Noble/Cosmos Hub/Osmosis sign themselves (see onrampActions.ts) and are
// the only origins offered here. Ethereum/Arbitrum/Base via the embedded
// Skip Go widget ("Other chains" tab) were pulled 2026-08-18: the widget's
// default API proxy (go.skip.build/api/skip) returns no
// access-control-allow-origin header for repegclub.com (confirmed live,
// both in-browser - "Failed to fetch... blocked by CORS policy" - and via
// curl comparing its preflight response against api.skip.build's, which
// DOES send `access-control-allow-origin: *` and is what the direct
// origins below call). Skip's own docs require reaching out on Discord to
// get a domain whitelisted for the widget's endpoint - not something
// fixable from this project's code. Not a loss in practice: EVM origins
// never reliably collected the 0.2% fee either (chainIdsToAffiliates only
// fires on an actual swap, and Ethereum/Arbitrum/Base -> Noble via CCTP is
// a pure bridge, no swap, same root cause already documented for Noble
// itself). Config for this path (ONRAMP_SOURCE_CHAINS, ONRAMP_FILTER,
// ONRAMP_DEFAULT_ROUTE, ONRAMP_THEME, the EVM entries in
// ONRAMP_CHAIN_AFFILIATES) is left in onrampConfig.ts, not deleted -
// restoring this tab once a whitelist comes through should just mean
// bringing the <Widget> branch back, not rebuilding the config.
// "Bring USDC" (DirectOriginForm, Noble/Cosmos Hub/Osmosis -> Terra
// Classic) and "Send assets" (DirectOutboundForm, Terra Classic ->
// BSC/Ethereum/Solana via Hyperlane) are opposite directions sharing one
// widget (product decision, 2026-09-02: stays one tool with more options,
// not two pages). First tried as one flat row of 6 chain tabs - found live
// that a user testing it couldn't tell "bring in" from "send out" from tab
// labels alone (Noble/BSC read the same at a glance, direction only
// legible by reading the paragraph below). Fixed by making direction its
// own explicit choice (the mode switch below), with which-chain as a
// second, nested choice underneath it - not by relabeling the tabs, which
// wouldn't have fixed the same-glance problem.
type Mode = "bring" | "send";

export function DirectTransferCard() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("bring");
  // Each mode remembers its own last-picked chain independently (2 separate
  // state slots, not 1 shared "selected tab") - switching modes and back
  // shouldn't reset which chain was chosen.
  const [selectedOrigin, setSelectedOrigin] = useState<DirectOriginChain>(DIRECT_ORIGIN_CHAINS[0]);
  const [selectedDestination, setSelectedDestination] = useState<HyperlaneDestination>(HYPERLANE_DESTINATIONS[0]);
  // Lifted up here (not local to DirectOriginForm) so it survives
  // switching between the Noble/Cosmos Hub/Osmosis tabs - the destination
  // is the same address no matter which origin tab is active, the user
  // shouldn't have to paste it again per tab. Pasted, not derived - see
  // isValidTerraClassicAddress in onrampActions.ts for why.
  const [terraClassicAddressInput, setTerraClassicAddressInput] = useState("");
  const terraClassicAddressValid = isValidTerraClassicAddress(terraClassicAddressInput);

  return (
    <div className="onramp-tool-panel pixel-stepped-corners">
      <div className="onramp-mode-switch" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "bring"}
          className={"onramp-mode-btn" + (mode === "bring" ? " onramp-mode-btn-active" : "")}
          onClick={() => setMode("bring")}
        >
          {t("onramp.modeBring")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "send"}
          className={"onramp-mode-btn" + (mode === "send" ? " onramp-mode-btn-active" : "")}
          onClick={() => setMode("send")}
        >
          {t("onramp.modeSend")}
        </button>
      </div>

      {mode === "bring" ? (
        <>
          <div className="onramp-tabs" role="tablist">
            {DIRECT_ORIGIN_CHAINS.map((chain, index) => (
              <button
                key={chain.chainId}
                type="button"
                role="tab"
                aria-selected={selectedOrigin.chainId === chain.chainId}
                // onramp-tab-cN: which of the 3 established accent colors
                // (green/blue/crimson) this tab turns into once picked -
                // stays plain gray otherwise, see
                // .onramp-tab-active.onramp-tab-cN in onramp.css.
                className={
                  `onramp-tab onramp-tab-c${index}` +
                  (selectedOrigin.chainId === chain.chainId ? " onramp-tab-active" : "")
                }
                onClick={() => setSelectedOrigin(chain)}
              >
                {chain.label}
              </button>
            ))}
          </div>
          <DirectOriginForm
            key={selectedOrigin.chainId}
            chain={selectedOrigin}
            terraClassicAddressInput={terraClassicAddressInput}
            onTerraClassicAddressInputChange={setTerraClassicAddressInput}
            terraClassicAddress={terraClassicAddressValid ? terraClassicAddressInput : null}
          />
        </>
      ) : (
        <>
          <div className="onramp-tabs" role="tablist">
            {HYPERLANE_DESTINATIONS.map((dest, index) => (
              <button
                key={dest.domain}
                type="button"
                role="tab"
                aria-selected={selectedDestination.domain === dest.domain}
                className={
                  `onramp-tab onramp-tab-c${index}` +
                  (selectedDestination.domain === dest.domain ? " onramp-tab-active" : "")
                }
                onClick={() => setSelectedDestination(dest)}
              >
                {dest.label}
              </button>
            ))}
          </div>
          <DirectOutboundForm key={`out-${selectedDestination.domain}`} destination={selectedDestination} />
        </>
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
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const connectBtnRef = useRef<HTMLButtonElement>(null);
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
        (() => {
          const provider = WALLET_PROVIDERS.find((p) => p.id === walletState.providerId)!;
          return (
            <div className="onramp-wallet-row onramp-wallet-row-error">
              <span className="onramp-error-text">
                {t(`wallet.${walletState.kind}`, { provider: provider.name })}
              </span>
              {walletState.kind === "notInstalled" ? (
                <a className="onramp-main-btn" href={provider.installUrl} target="_blank" rel="noreferrer">
                  {t("wallet.install", { provider: provider.name })}
                </a>
              ) : (
                <button
                  className="onramp-main-btn"
                  onClick={() => connect(walletState.providerId, walletState.type)}
                >
                  {t("wallet.retry")}
                </button>
              )}
              {/* Without this, a rejected/failed attempt only offers Retry
                  on the SAME provider - no way back to the picker short of
                  reloading the page (found live, 2026-08-19). */}
              <button className="onramp-ghost-btn" onClick={disconnect}>
                {t("wallet.chooseAnother")}
              </button>
            </div>
          );
        })()
      ) : (
        <>
          <button
            ref={connectBtnRef}
            className="onramp-main-btn"
            onClick={() => setProviderMenuOpen((open) => !open)}
            disabled={walletState.status === "connecting"}
            aria-haspopup="menu"
            aria-expanded={providerMenuOpen}
          >
            {walletState.status === "connecting"
              ? t("wallet.connecting")
              : t("onramp.direct.connectButton", { chain: chain.label })}
          </button>
          {providerMenuOpen && (
            <WalletProviderPopover
              anchorRef={connectBtnRef}
              onClose={() => setProviderMenuOpen(false)}
              onSelect={(providerId, type) => {
                setProviderMenuOpen(false);
                connect(providerId, type);
              }}
            />
          )}
        </>
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

// Mirrors DirectOriginForm's structure/validation rigor, adapted for the
// reversed direction (2026-09-02): the wallet connects to Terra Classic
// itself (always TERRA_CLASSIC_MAINNET, not per-tab), the asset is
// LUNC/USTC leaving TC rather than something arriving, and the pasted
// address is EVM/Solana-shaped instead of terra1... Kept as its own
// component rather than parameterizing DirectOriginForm - the extra
// Hyperlane gas reserve (ulunaReserve below) doesn't fit that component's
// existing gasIsSameDenom/maxGasReserve math without contorting it.
function DirectOutboundForm({ destination }: { destination: HyperlaneDestination }) {
  const { t } = useTranslation();
  const chain = TERRA_CLASSIC_MAINNET;
  const { state: walletState, connect, disconnect } = useCosmosWallet(chain);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const connectBtnRef = useRef<HTMLButtonElement>(null);
  const address = walletState.status === "connected" ? walletState.address : null;

  const [assetSymbol, setAssetSymbol] = useState<HyperlaneAsset>("LUNC");
  const asset = chain.assets.find((a) => a.symbol === assetSymbol) ?? chain.assets[0];
  const balance = useBalance(address, asset.denom, chain.lcd);

  // The Hyperlane gas payment (igpFeeUluna) is always uluna, on top of the
  // ordinary tx gas reserve (chain.maxGasReserve, also uluna) - when the
  // asset being bridged ISN'T uluna (USTC), both draw from a wholly
  // separate uluna balance the asset balance above says nothing about.
  // Same gasIsSameDenom reasoning as DirectOriginForm, with the IGP fee
  // folded into what has to be reserved/checked.
  const assetIsUluna = asset.denom === HYPERLANE_TERRA_CLASSIC_WARP.LUNC.denom;
  const ulunaReserve = destination.igpFeeUluna + chain.maxGasReserve;
  const ulunaBalance = useBalance(assetIsUluna ? null : address, "uluna", chain.lcd);
  const hasUlunaForFee =
    assetIsUluna || (ulunaBalance.status === "loaded" && BigInt(ulunaBalance.amount) >= ulunaReserve);

  const [destAddressInput, setDestAddressInput] = useState("");
  const destAddressValidator = destination.kind === "evm" ? isValidEvmAddress : isValidSolanaAddress;
  const destAddressValid = destAddressValidator(destAddressInput);
  const destAddressInvalid = destAddressInput !== "" && !destAddressValid;

  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Same reasoning as DirectOriginForm's outcomeUnknown - see the comment
  // there.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);

  const amountNumber = Number(amountInput);
  const amountRaw = displayToMicro(amountNumber);
  const amountValid =
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    amountRaw > 0n &&
    balance.status === "loaded" &&
    amountRaw <= BigInt(balance.amount) &&
    (!assetIsUluna || amountRaw + ulunaReserve <= BigInt(balance.amount)) &&
    hasUlunaForFee &&
    destAddressValid;
  const { transferAmount, treasuryAmount, feeKeeperAmount } = getDirectFeeSplit(chain.chainId, amountRaw);

  function handleAssetChange(symbol: string) {
    if (symbol !== "LUNC" && symbol !== "USTC") return;
    setAssetSymbol(symbol);
    setAmountInput("");
    setTxHash(null);
    setError(null);
    setOutcomeUnknown(false);
  }

  function handleMax() {
    if (balance.status !== "loaded") return;
    const raw = BigInt(balance.amount);
    // Only uluna needs headroom reserved off the top - a USTC balance
    // doesn't need any of itself held back (the IGP fee + tx gas come out
    // of the separate uluna balance instead, checked by hasUlunaForFee).
    const reserve = assetIsUluna ? ulunaReserve : 0n;
    const max = raw > reserve ? raw - reserve : 0n;
    setAmountInput(microToDisplay(max).toString());
  }

  async function handleSend() {
    if (walletState.status !== "connected" || !amountValid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendOutViaHyperlane(
        walletState.wallet,
        assetSymbol,
        destination,
        amountRaw,
        destAddressInput
      );
      setTxHash(result.res.txResponse.txhash);
      setAmountInput("");
      balance.refetch();
      if (!assetIsUluna) ulunaBalance.refetch();
    } catch (err) {
      // Same TypeError-vs-thrown-Error distinction as DirectOriginForm's
      // handleSend - see the comment there.
      if (err instanceof TypeError) {
        console.error(err);
        setOutcomeUnknown(true);
      } else {
        setError(err instanceof Error ? err.message : t("onramp.outbound.sendFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onramp-panel">
      <p className="onramp-panel-desc">{t("onramp.outbound.desc", { chain: destination.label })}</p>

      <select
        className="onramp-asset-select"
        value={assetSymbol}
        onChange={(e) => handleAssetChange(e.target.value)}
        aria-label={t("onramp.direct.assetSelectLabel")}
      >
        <option value="LUNC">LUNC</option>
        <option value="USTC">USTC</option>
      </select>

      {walletState.status === "connected" ? (
        <div className="onramp-wallet-row">
          <span className="onramp-wallet-dot" />
          <span className="onramp-wallet-address">{truncate(walletState.address)}</span>
          <button className="onramp-ghost-btn" onClick={disconnect}>
            {t("wallet.disconnect")}
          </button>
        </div>
      ) : walletState.status === "error" ? (
        (() => {
          const provider = WALLET_PROVIDERS.find((p) => p.id === walletState.providerId)!;
          return (
            <div className="onramp-wallet-row onramp-wallet-row-error">
              <span className="onramp-error-text">
                {t(`wallet.${walletState.kind}`, { provider: provider.name })}
              </span>
              {walletState.kind === "notInstalled" ? (
                <a className="onramp-main-btn" href={provider.installUrl} target="_blank" rel="noreferrer">
                  {t("wallet.install", { provider: provider.name })}
                </a>
              ) : (
                <button
                  className="onramp-main-btn"
                  onClick={() => connect(walletState.providerId, walletState.type)}
                >
                  {t("wallet.retry")}
                </button>
              )}
              <button className="onramp-ghost-btn" onClick={disconnect}>
                {t("wallet.chooseAnother")}
              </button>
            </div>
          );
        })()
      ) : (
        <>
          <button
            ref={connectBtnRef}
            className="onramp-main-btn"
            onClick={() => setProviderMenuOpen((open) => !open)}
            disabled={walletState.status === "connecting"}
            aria-haspopup="menu"
            aria-expanded={providerMenuOpen}
          >
            {walletState.status === "connecting" ? t("wallet.connecting") : t("onramp.outbound.connectButton")}
          </button>
          {/* No "Mobile (scan QR)" group here - see allowMobile's comment in
              WalletProviderOptions.tsx. The hint below points phone users
              at the option that does work (open this site inside Keplr's/
              Galaxy Station's own app, then use the plain, non-QR button
              above). */}
          <p className="onramp-dest-warning">{t("onramp.outbound.mobileHint")}</p>
          {providerMenuOpen && (
            <WalletProviderPopover
              anchorRef={connectBtnRef}
              onClose={() => setProviderMenuOpen(false)}
              onSelect={(providerId, type) => {
                setProviderMenuOpen(false);
                connect(providerId, type);
              }}
              allowMobile={false}
            />
          )}
        </>
      )}

      {walletState.status === "connected" && (
        <>
          {balance.status === "loaded" && (
            <p className="onramp-balance-note">
              {t("onramp.direct.balance", {
                amount: microToDisplay(BigInt(balance.amount)).toFixed(2),
                symbol: assetSymbol,
              })}
            </p>
          )}
          <label className="onramp-field-label" htmlFor={`outbound-amount-${destination.domain}`}>
            {t("onramp.direct.amountLabel")}
          </label>
          <div className="onramp-input-row">
            <div className="onramp-input-wrap">
              <input
                id={`outbound-amount-${destination.domain}`}
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
              <span className="onramp-input-unit">{assetSymbol}</span>
            </div>
            {balance.status === "loaded" && (
              <button type="button" className="onramp-ghost-btn" onClick={handleMax}>
                {t("wheel.redeemMax")}
              </button>
            )}
          </div>

          <label className="onramp-field-label" htmlFor={`outbound-address-${destination.domain}`}>
            {destination.kind === "evm"
              ? t("onramp.outbound.evmAddressLabel")
              : t("onramp.outbound.solanaAddressLabel")}
          </label>
          <div className={"onramp-input-wrap" + (destAddressInvalid ? " onramp-dest-input-invalid" : "")}>
            <input
              id={`outbound-address-${destination.domain}`}
              type="text"
              placeholder={destination.kind === "evm" ? "0x..." : t("onramp.outbound.solanaAddressPlaceholder")}
              value={destAddressInput}
              onChange={(e) => setDestAddressInput(e.target.value.trim())}
              className="onramp-input"
            />
          </div>
          {destAddressInvalid ? (
            <p className="onramp-error-text">
              {destination.kind === "evm"
                ? t("onramp.outbound.evmAddressInvalid")
                : t("onramp.outbound.solanaAddressInvalid")}
            </p>
          ) : (
            <p className="onramp-dest-warning">{t("onramp.direct.destAddressWarning")}</p>
          )}

          {!hasUlunaForFee && <p className="onramp-error-text">{t("onramp.outbound.gasNeeded")}</p>}

          {/* Wallets don't auto-detect a brand-new token by themselves (an
              EVM wallet needs the contract address pasted in manually;
              Solana wallets are more likely to pick it up on their own,
              but not guaranteed) - found live, 2026-09-02: the user sent a
              real transfer and couldn't find the balance until told the
              exact contract address to add. Shown before sending (so it
              can be copied ahead of time) and repeated in the success
              message below, since that's the moment it's actually needed. */}
          <p className="onramp-dest-warning">
            {destination.kind === "evm"
              ? t("onramp.outbound.tokenHintEvm", {
                  symbol: assetSymbol,
                  address: destination.tokenAddress[assetSymbol],
                })
              : t("onramp.outbound.tokenHintSolana", { address: destination.tokenAddress[assetSymbol] })}
          </p>

          {amountValid && (
            <p className="onramp-breakdown">
              {t("onramp.outbound.breakdown", {
                fee: microToDisplay(treasuryAmount + feeKeeperAmount).toFixed(4),
                symbol: assetSymbol,
                send: microToDisplay(transferAmount).toFixed(2),
                chain: destination.label,
                gas: microToDisplay(destination.igpFeeUluna).toFixed(2),
              })}
            </p>
          )}

          <button
            className="onramp-main-btn onramp-send-btn"
            onClick={handleSend}
            disabled={busy || !amountValid || outcomeUnknown}
          >
            {busy ? t("onramp.direct.sending") : t("onramp.outbound.sendButton", { chain: destination.label })}
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
          {txHash && (
            <p className="onramp-success-text">
              {t("onramp.direct.sent", { hash: txHash })}
              <br />
              {destination.kind === "evm"
                ? t("onramp.outbound.tokenHintEvm", {
                    symbol: assetSymbol,
                    address: destination.tokenAddress[assetSymbol],
                  })
                : t("onramp.outbound.tokenHintSolana", { address: destination.tokenAddress[assetSymbol] })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
