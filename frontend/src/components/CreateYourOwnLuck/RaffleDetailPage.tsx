import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameSwitcher } from "../Shared/GameSwitcher";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { useWallet } from "../../contexts/WalletContext";
import { useCyolRaffleDetail } from "../../hooks/useCyolRaffleDetail";
import { useCyolRaffleIndex } from "../../hooks/useCyolRaffleIndex";
import { displayNumberToUluna, ulunaToDisplayNumber } from "../../lib/format";
import { prizeCurrencyLabel, formatAmount } from "../../lib/cyolFormat";
import { worstCaseTicketRevenueProfit } from "../../lib/cyolFundingDisclosure";
import { walletConcentration, concentrationBand } from "../../lib/cyolChecklist";
import { useTokenPrices } from "../../hooks/useTokenPrices";
import { priceForDenom } from "../../lib/tokenPrices";
import { CyolSafetyChecklist } from "./CyolSafetyChecklist";
import {
  depositPrize,
  payServiceFee,
  buyTickets,
  withdrawTicket,
  closeRound,
  drawWinner,
  claimAirdropShare,
  reclaimUnclaimed,
  cancelRaffle,
  expireRaffle,
} from "../../lib/cyolActions";
import { friendlyCyolError } from "../../lib/cyolErrorMessages";
import { CyolVerifyPanel } from "./CyolVerifyPanel";
import { CyolRevealWheel } from "./CyolRevealWheel";
import { CyolRevealChest } from "./CyolRevealChest";

// Mirrors max_tickets_per_wallet exactly (contracts/create-your-own-luck/
// src/execute.rs) - lets the UI cap a batch purchase client-side instead of
// letting a wallet type a number the contract is guaranteed to reject
// (which would revert the whole batched transaction, not just the excess).
function maxTicketsPerWallet(raffleType: string, maxPlayers: number, ticketPrice: string): number {
  if (ticketPrice === "0") return 1;
  if (raffleType === "airdrop") return 1;
  return Math.max(1, Math.floor(maxPlayers / 2));
}

type ActionKey = "fund" | "buy" | "withdraw" | "close" | "draw" | "claim" | "reclaim" | "cancel" | "expire";

// Shared by both the buyer-side and creator-side value-mismatch warnings
// below (security catalog's hallazgo #6, 2026-07-25/26): unlike the
// self-buy warning's simple confirm/cancel, this one requires an explicit
// checkbox before the confirm button becomes clickable - a real financial
// decision (paying more than you'd get back, or shortchanging your own
// participants), not just a reputational nudge.
function ValueMismatchWarningModal({
  bodyText,
  onCancel,
  onConfirm,
}: {
  bodyText: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  return (
    <div className="history-overlay" onClick={onCancel}>
      <div className="history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="history-modal-header">
          <h2 className="history-modal-title">{t("createYourOwnLuck.detail.valueMismatchWarningTitle")}</h2>
          <button type="button" className="history-close-btn" onClick={onCancel}>
            ✕
          </button>
        </div>
        <p className="cyol-modal-body-text">{bodyText}</p>
        <label className="cyol-checkbox-label">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {t("createYourOwnLuck.detail.valueMismatchWarningCheckbox")}
        </label>
        <div className="cyol-detail-actions">
          <button className="cyol-submit cyol-submit-secondary" onClick={onCancel}>
            {t("createYourOwnLuck.detail.selfBuyWarningCancel")}
          </button>
          <button className="cyol-submit" onClick={onConfirm} disabled={!checked}>
            {t("createYourOwnLuck.detail.valueMismatchWarningConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// The full raffle lifecycle, built to be testable first: buttons show up
// within their coarse status window (Open, Closed, ...) and the contract's
// own validation is the source of truth for the fine-grained eligibility
// (draw window height, unclaimed deadline, rearm cap) - its rejection
// message surfaces as-is instead of this page trying to precompute exact
// countdowns for all of them. SingleWinner's result is revealed via the same
// wheel/physics Wheel of Repeg uses (see CyolRevealWheel) - Airdrop has no
// winner to reveal, so it gets its own reveal moment instead, a chest that
// only a participating wallet can open, revealing its own per-wallet split
// (see CyolRevealChest).
export function RaffleDetailPage() {
  const { t } = useTranslation();
  const { address = "" } = useParams<{ address: string }>();
  const location = useLocation();
  const { state: walletState } = useWallet();
  const walletAddress = walletState.status === "connected" ? walletState.wallet.address : null;
  const detail = useCyolRaffleDetail(address, walletAddress);
  const raffleIndex = useCyolRaffleIndex(address);

  // Prefilled from CreatorForm's own planning field when navigated here
  // straight after creating this raffle (see CreatorForm.tsx) - falls back
  // to the old flat default on a direct visit/reload, where that router
  // state doesn't exist.
  const plannedPrizeAmount = (location.state as { plannedPrizeAmount?: string } | null)?.plannedPrizeAmount;
  const [prizeAmount, setPrizeAmount] = useState(plannedPrizeAmount ?? "100");
  const [ticketQuantity, setTicketQuantity] = useState("1");
  const [actionBusy, setActionBusy] = useState<ActionKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  const [showSelfBuyWarning, setShowSelfBuyWarning] = useState(false);
  const [showBuyValueWarning, setShowBuyValueWarning] = useState(false);
  const [showFundValueWarning, setShowFundValueWarning] = useState(false);
  const tokenPrices = useTokenPrices();

  useEffect(() => {
    const id = setInterval(() => setNowSec(Date.now() / 1000), 5000);
    return () => clearInterval(id);
  }, []);

  // Keeps the safety checklist's wallet-concentration signal live while a
  // decision is still pending - other wallets buying tickets wouldn't
  // otherwise show up here until this wallet's own next action triggers a
  // refetch (see `run()` below).
  const raffleOpenStatus = detail.status === "loaded" ? detail.raffleStatus.status : null;
  useEffect(() => {
    if (raffleOpenStatus !== "open") return;
    const id = setInterval(() => detail.refetch(), 12_000);
    return () => clearInterval(id);
    // detail.refetch is stable (see useCyolRaffleDetail); the full `detail`
    // object is a fresh literal every render (`{ ...state, refetch: load }`),
    // so depending on it here would tear down and restart this interval on
    // every render instead of every 12s - same reasoning as the
    // exhaustive-deps suppression in WeeklyWheelCard.tsx's countdown effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raffleOpenStatus, detail.refetch]);

  const shell = (children: React.ReactNode) => (
    <main className="wheel-page cyol-page">
      <div className="wallet-bar">
        <ConnectWalletButton />
      </div>
      <GameSwitcher current="/create-your-own-luck" />
      <Link className="cyol-back-link" to="/create-your-own-luck">
        {t("createYourOwnLuck.detail.back")}
      </Link>
      {children}
    </main>
  );

  if (detail.status === "loading") return shell(<p>{t("createYourOwnLuck.loading")}</p>);
  if (detail.status === "error") return shell(<p className="cyol-form-error">{t("createYourOwnLuck.cardError")}</p>);

  const { config, raffleStatus, winners, myAirdropShare, myTicketCount, entrants } = detail;

  if (config.raffle_type === "podium") {
    return shell(<p className="cyol-form-error">{t("createYourOwnLuck.detail.podiumUnsupported")}</p>);
  }

  const prizeDenom = "native" in config.prize_asset ? config.prize_asset.native.denom : null;
  const isAirdrop = config.raffle_type === "airdrop";
  const isCreator = walletAddress !== null && walletAddress === config.creator;
  const connected = walletState.status === "connected";
  const busy = actionBusy !== null;

  // Airdrop-specific value-mismatch check (security catalog's hallazgo #6):
  // a paid raffle's ticket is always USDC (~$1), but the prize can be any
  // of LUNC/USDC/USTC - if each wallet's guaranteed share is worth less
  // than the ticket at real market prices, someone's paying more than
  // they'll get back, even in the best case. Only meaningful for a paid
  // Airdrop (a free raffle risks nothing, and SingleWinner/Podium's
  // prize-vs-ticket mismatch is normal lottery variance, not this).
  const isPaid = config.ticket_price !== "0";
  const ticketPriceUsd = ulunaToDisplayNumber(config.ticket_price);
  const prizeAssetPrice =
    prizeDenom && tokenPrices.status === "loaded" ? priceForDenom(prizeDenom, tokenPrices.prices) : null;
  const fundedPrizeUsd =
    isAirdrop && prizeAssetPrice !== null ? ulunaToDisplayNumber(raffleStatus.prize_amount) * prizeAssetPrice : null;
  const buyWorstCaseShareUsd = fundedPrizeUsd !== null ? fundedPrizeUsd / config.max_players : null;
  const buyValueMismatch = isAirdrop && isPaid && buyWorstCaseShareUsd !== null && buyWorstCaseShareUsd < ticketPriceUsd;

  const plannedPrizeNum = Number(prizeAmount);
  const plannedPrizeUsd =
    isAirdrop && prizeAssetPrice !== null && Number.isFinite(plannedPrizeNum)
      ? plannedPrizeNum * prizeAssetPrice
      : null;
  const fundWorstCaseShareUsd = plannedPrizeUsd !== null ? plannedPrizeUsd / config.max_players : null;
  const fundValueMismatch = isAirdrop && isPaid && fundWorstCaseShareUsd !== null && fundWorstCaseShareUsd < ticketPriceUsd;

  const hasMin = raffleStatus.unique_player_count >= config.min_players;
  const reachedMax = raffleStatus.unique_player_count >= config.max_players;
  const timeoutElapsed = raffleStatus.seconds_remaining !== null && raffleStatus.seconds_remaining <= 0;
  const ageReached =
    raffleStatus.opened_at !== null && nowSec >= raffleStatus.opened_at + config.max_raffle_age_seconds;

  const canFund = isCreator && raffleStatus.status === "funding" && prizeDenom !== null;
  const canBuyTicket = raffleStatus.status === "open";
  const ticketCap = maxTicketsPerWallet(config.raffle_type, config.max_players, config.ticket_price);
  const maxMoreTickets = Math.max(0, ticketCap - (myTicketCount ?? 0));
  const canWithdrawTicket = raffleStatus.status === "open" && !hasMin;
  const canCloseRound =
    raffleStatus.status === "open" && (reachedMax || (timeoutElapsed && hasMin) || (isCreator && hasMin));
  const canExpireRaffle = raffleStatus.status === "open" && !hasMin && ageReached;
  const canCancelRaffle = isCreator && (raffleStatus.status === "funding" || raffleStatus.status === "open");
  const canDrawWinner = raffleStatus.status === "closed";
  const canClaimAirdrop =
    raffleStatus.status === "drawn" && isAirdrop && myAirdropShare !== null && !myAirdropShare.claimed && myAirdropShare.share !== "0";
  const canReclaimUnclaimed = isCreator && raffleStatus.status === "drawn" && isAirdrop;

  async function run(key: ActionKey, fn: () => Promise<unknown>) {
    setActionBusy(key);
    setActionError(null);
    try {
      await fn();
      detail.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? friendlyCyolError(err.message) : t("createYourOwnLuck.detail.errorGeneric"));
    } finally {
      setActionBusy(null);
    }
  }

  function runFund() {
    if (walletState.status !== "connected" || !prizeDenom) return;
    const wallet = walletState.wallet;
    const amount = displayNumberToUluna(Number(prizeAmount));
    const sameDenomAsFee = prizeDenom === config.usdc_denom;
    run("fund", async () => {
      if (sameDenomAsFee && !raffleStatus.fee_paid) {
        await payServiceFee(wallet, address, config.usdc_denom, config.fee_amount_usdc);
      }
      await depositPrize(
        wallet,
        address,
        prizeDenom,
        amount,
        config.usdc_denom,
        config.fee_amount_usdc,
        raffleStatus.fee_paid || sameDenomAsFee
      );
    });
  }
  function handleFund() {
    if (walletState.status !== "connected" || !prizeDenom) return;
    if (fundValueMismatch) {
      setShowFundValueWarning(true);
      return;
    }
    runFund();
  }
  function confirmFundValueWarning() {
    setShowFundValueWarning(false);
    runFund();
  }
  function runBuyTicket() {
    if (walletState.status !== "connected") return;
    const quantity = Math.min(Math.max(1, Math.floor(Number(ticketQuantity)) || 1), maxMoreTickets);
    run("buy", () =>
      buyTickets(walletState.wallet, address, config.ticket_denom, config.ticket_price, quantity)
    );
  }
  // The creator buying into their own raffle costs them nothing (their own
  // ticket_revenue contribution always comes back to them at draw time) and
  // gives them an extra shot at winning back the prize they funded - a real
  // self-dealing signal (see "Repeg Club - Create Your Own Luck (seguridad,
  // hallazgos y exploits)", hallazgo #1). Purely a deterrent, not a real
  // block - a determined creator can always use an undeclared second wallet
  // - so this warns and lets them confirm, it never disables the button.
  function handleBuyTicket() {
    if (walletState.status !== "connected") return;
    if (isCreator) {
      setShowSelfBuyWarning(true);
      return;
    }
    if (buyValueMismatch) {
      setShowBuyValueWarning(true);
      return;
    }
    runBuyTicket();
  }
  function confirmSelfBuy() {
    setShowSelfBuyWarning(false);
    if (buyValueMismatch) {
      setShowBuyValueWarning(true);
      return;
    }
    runBuyTicket();
  }
  function confirmBuyValueWarning() {
    setShowBuyValueWarning(false);
    runBuyTicket();
  }
  function handleWithdrawTicket() {
    if (walletState.status !== "connected") return;
    run("withdraw", () => withdrawTicket(walletState.wallet, address));
  }
  function handleCloseRound() {
    if (walletState.status !== "connected") return;
    run("close", () => closeRound(walletState.wallet, address));
  }
  function handleDrawWinner() {
    if (walletState.status !== "connected") return;
    run("draw", () => drawWinner(walletState.wallet, address));
  }
  function handleClaimAirdrop() {
    if (walletState.status !== "connected") return;
    run("claim", () => claimAirdropShare(walletState.wallet, address));
  }
  function handleReclaimUnclaimed() {
    if (walletState.status !== "connected") return;
    run("reclaim", () => reclaimUnclaimed(walletState.wallet, address));
  }
  function handleCancelRaffle() {
    if (walletState.status !== "connected") return;
    run("cancel", () => cancelRaffle(walletState.wallet, address));
  }
  function handleExpireRaffle() {
    if (walletState.status !== "connected") return;
    run("expire", () => expireRaffle(walletState.wallet, address));
  }

  const prizeCurrency = prizeCurrencyLabel(prizeDenom ?? config.usdc_denom);

  const winnerDetail =
    !isAirdrop && winners && winners.winners.length > 0 ? (
      <div>
        <p className="cyol-detail-line cyol-detail-highlight">
          {winners.winners.length > 1 ? t("createYourOwnLuck.detail.winnersTitle") : t("createYourOwnLuck.detail.winnerTitle")}
        </p>
        {winners.winners.map((winner, i) =>
          winner === walletAddress ? (
            <div key={winner}>
              <p className="cyol-detail-line cyol-detail-highlight">
                {t("createYourOwnLuck.detail.youWonLine", {
                  prize: formatAmount(winners.prize_shares[i] ?? "0", prizeCurrency),
                })}
              </p>
              <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.prizeSentTo", { winner })}</p>
            </div>
          ) : (
            <p key={winner} className="cyol-detail-line">
              {t("createYourOwnLuck.detail.winnerLine", {
                winner,
                prize: formatAmount(winners.prize_shares[i] ?? "0", prizeCurrency),
              })}
            </p>
          )
        )}
        {winners.winners.length === 1 && (
          <CyolVerifyPanel contractAddress={address} winnerAddress={winners.winners[0]} />
        )}
      </div>
    ) : null;

  return shell(
    <>
    <div className="cyol-detail">
      <div className="cyol-card-top">
        <span className="cyol-card-type">
          {raffleIndex !== null && `${t("createYourOwnLuck.raffleIdLabel", { id: raffleIndex })} · `}
          {t(`createYourOwnLuck.raffleType.${config.raffle_type === "single_winner" ? "singleWinner" : config.raffle_type}`)}
        </span>
        <span className={`cyol-card-status cyol-card-status-${raffleStatus.status}`}>
          {t(`createYourOwnLuck.status.${raffleStatus.status}`)}
        </span>
      </div>
      <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.contractAddressLabel")}</p>
      <p className="cyol-card-address">{address}</p>
      <p className="cyol-detail-line">{t("createYourOwnLuck.detail.creator", { creator: config.creator })}</p>
      <p className="cyol-detail-line">
        {t("createYourOwnLuck.ticketPrice", { price: formatAmount(config.ticket_price, "USDC") })}
      </p>
      <p className="cyol-detail-line">
        {t("createYourOwnLuck.players", { count: raffleStatus.unique_player_count, max: config.max_players })}
      </p>
      <p className="cyol-detail-line">
        {t(
          isAirdrop ? "createYourOwnLuck.detail.totalTicketsOnePerWallet" : "createYourOwnLuck.detail.totalTickets",
          { count: raffleStatus.ticket_count }
        )}
      </p>
      {connected && myTicketCount !== null && myTicketCount > 0 && (
        <p className="cyol-detail-line cyol-detail-highlight">{t("createYourOwnLuck.detail.myTickets", { count: myTicketCount })}</p>
      )}
      {raffleStatus.prize_amount !== "0" && (
        <p className="cyol-detail-line">
          {t("createYourOwnLuck.detail.prize", { prize: formatAmount(raffleStatus.prize_amount, prizeCurrency) })}
        </p>
      )}
      {!prizeDenom && <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.cw20NotSupported")}</p>}

      <CyolSafetyChecklist config={config} raffleStatus={raffleStatus} entrants={entrants} />

      {actionError && <p className="cyol-form-error">{actionError}</p>}

      {raffleStatus.status === "funding" &&
        (canFund ? (
          <div className="cyol-detail-action">
            <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.fundHint")}</p>
            <label className="cyol-field">
              <span>{t("createYourOwnLuck.detail.prizeAmountLabel", { currency: prizeCurrency })}</span>
              <input type="number" min="0" step="0.01" value={prizeAmount} onChange={(e) => setPrizeAmount(e.target.value)} />
              {(config.raffle_type === "single_winner" || config.raffle_type === "airdrop") &&
                (() => {
                  const prize = Number(prizeAmount);
                  if (!Number.isFinite(prize) || prizeAssetPrice === null) return null;
                  // Prize amount is in whatever asset this raffle uses, not
                  // necessarily USDC - convert to real USD before comparing
                  // against ticket revenue (a paid ticket is always USDC).
                  const prizeUsd = prize * prizeAssetPrice;
                  const profit = worstCaseTicketRevenueProfit(
                    config.raffle_type,
                    config.max_players,
                    ticketPriceUsd,
                    prizeUsd
                  );
                  return (
                    <span className="cyol-hint">
                      {profit > 0
                        ? t("createYourOwnLuck.detail.fundraiserDisclosurePositive", { amount: profit.toFixed(2) })
                        : t("createYourOwnLuck.detail.fundraiserDisclosureNegative", { amount: Math.abs(profit).toFixed(2) })}
                    </span>
                  );
                })()}
            </label>
            <button className="cyol-submit" onClick={handleFund} disabled={busy || !connected}>
              {actionBusy === "fund" ? t("createYourOwnLuck.detail.funding") : t("createYourOwnLuck.detail.fund")}
            </button>
          </div>
        ) : (
          <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.waitingForFunding")}</p>
        ))}

      {raffleStatus.status === "open" && (
        <div className="cyol-detail-actions">
          {canBuyTicket && (
            <div className="cyol-buy-group">
              <div className="cyol-buy-row">
                {!isAirdrop && maxMoreTickets > 1 && (
                  <input
                    type="number"
                    className="cyol-buy-quantity"
                    min="1"
                    max={maxMoreTickets}
                    value={ticketQuantity}
                    onChange={(e) => {
                      // Clamp immediately, in the field itself - the HTML
                      // `max` attribute alone doesn't stop someone from
                      // typing a bigger number, and silently capping only at
                      // submit time (still correct - see
                      // cyolActions.buyTickets) left the field showing a
                      // number nothing like what Keplr was about to ask for
                      // a signature on.
                      const parsed = Math.floor(Number(e.target.value)) || 1;
                      setTicketQuantity(String(Math.min(Math.max(1, parsed), maxMoreTickets)));
                    }}
                    disabled={busy || !connected}
                    aria-label={t("createYourOwnLuck.detail.ticketQuantityLabel")}
                  />
                )}
                <button
                  className="cyol-submit"
                  onClick={handleBuyTicket}
                  disabled={busy || !connected || maxMoreTickets < 1}
                  title={maxMoreTickets < 1 ? t("createYourOwnLuck.detail.ticketCapReached", { cap: ticketCap }) : undefined}
                >
                  {actionBusy === "buy"
                    ? t("createYourOwnLuck.detail.buying")
                    : Number(ticketQuantity) > 1
                      ? t("createYourOwnLuck.detail.buyTickets", { count: Math.min(Number(ticketQuantity) || 1, maxMoreTickets) })
                      : t("createYourOwnLuck.detail.buyTicket")}
                </button>
              </div>
              {!isAirdrop && maxMoreTickets > 1 && (
                <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.maxAvailable", { max: maxMoreTickets })}</p>
              )}
            </div>
          )}
          {canWithdrawTicket && (
            <button className="cyol-submit cyol-submit-secondary" onClick={handleWithdrawTicket} disabled={busy || !connected}>
              {actionBusy === "withdraw" ? t("createYourOwnLuck.detail.withdrawing") : t("createYourOwnLuck.detail.withdrawTicket")}
            </button>
          )}
          {canCloseRound && (
            <div className="cyol-buy-group">
              <button className="cyol-submit cyol-submit-secondary" onClick={handleCloseRound} disabled={busy || !connected}>
                {actionBusy === "close" ? t("createYourOwnLuck.detail.closing") : t("createYourOwnLuck.detail.closeRound")}
              </button>
              {/* Only the creator's own choice to close early (not the
                  automatic max-players/timeout paths) is a real decision
                  that reputation should track - see the security catalog's
                  "distinción de responsabilidad" note. */}
              {isCreator && !reachedMax && !timeoutElapsed && (
                <p className="cyol-detail-hint">
                  {concentrationBand(walletConcentration(entrants)) === "green"
                    ? t("createYourOwnLuck.detail.closeReputationHintGood")
                    : t("createYourOwnLuck.detail.closeReputationHintBad")}
                </p>
              )}
            </div>
          )}
          {canExpireRaffle && (
            <button className="cyol-submit cyol-submit-secondary" onClick={handleExpireRaffle} disabled={busy || !connected}>
              {actionBusy === "expire" ? t("createYourOwnLuck.detail.expiring") : t("createYourOwnLuck.detail.expireRaffle")}
            </button>
          )}
        </div>
      )}

      {raffleStatus.status === "closed" && canDrawWinner && (
        <button className="cyol-submit" onClick={handleDrawWinner} disabled={busy || !connected}>
          {actionBusy === "draw" ? t("createYourOwnLuck.detail.drawing") : t("createYourOwnLuck.detail.drawWinner")}
        </button>
      )}

      {raffleStatus.status === "drawn" && (
        <div className="cyol-detail-actions">
          {winnerDetail &&
            (winners && entrants.length > 0 ? (
              <CyolRevealWheel key={address} contractAddress={address} entrants={entrants} winnerAddress={winners.winners[0]}>
                {winnerDetail}
              </CyolRevealWheel>
            ) : (
              // Raffles from before GetEntrants existed (see
              // useCyolRaffleDetail) have no ticket list to build wheel
              // segments from - fall back to the plain-text reveal rather
              // than showing a wheel that can never spin.
              winnerDetail
            ))}
          {isAirdrop && (
            <CyolRevealChest
              key={`${address}:${walletAddress ?? ""}`}
              contractAddress={address}
              walletAddress={walletAddress}
              myAirdropShare={myAirdropShare}
              prizeCurrency={prizeCurrency}
            >
              {myAirdropShare?.claimed && <p className="cyol-detail-line">{t("createYourOwnLuck.detail.airdropClaimed")}</p>}
              {canClaimAirdrop && (
                <button className="cyol-submit" onClick={handleClaimAirdrop} disabled={busy || !connected}>
                  {actionBusy === "claim" ? t("createYourOwnLuck.detail.claiming") : t("createYourOwnLuck.detail.claimAirdrop")}
                </button>
              )}
            </CyolRevealChest>
          )}
          {/* Creator-only, independent of whether this wallet is itself a
              participant (the creator may not have bought a ticket) - stays
              outside the chest's participant gate. */}
          {canReclaimUnclaimed && (
            <button className="cyol-submit cyol-submit-secondary" onClick={handleReclaimUnclaimed} disabled={busy || !connected}>
              {actionBusy === "reclaim" ? t("createYourOwnLuck.detail.reclaiming") : t("createYourOwnLuck.detail.reclaimUnclaimed")}
            </button>
          )}
        </div>
      )}

      {raffleStatus.status === "cancelled" && <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.cancelled")}</p>}

      {canCancelRaffle && (
        <button className="cyol-cancel-link" onClick={handleCancelRaffle} disabled={busy || !connected}>
          {actionBusy === "cancel" ? t("createYourOwnLuck.detail.cancelling") : t("createYourOwnLuck.detail.cancelRaffle")}
        </button>
      )}
    </div>

    {showSelfBuyWarning && (
      <div className="history-overlay" onClick={() => setShowSelfBuyWarning(false)}>
        <div className="history-modal" onClick={(e) => e.stopPropagation()}>
          <div className="history-modal-header">
            <h2 className="history-modal-title">{t("createYourOwnLuck.detail.selfBuyWarningTitle")}</h2>
            <button type="button" className="history-close-btn" onClick={() => setShowSelfBuyWarning(false)}>
              ✕
            </button>
          </div>
          <p className="cyol-modal-body-text">{t("createYourOwnLuck.detail.selfBuyWarningBody")}</p>
          <div className="cyol-detail-actions">
            <button className="cyol-submit cyol-submit-secondary" onClick={() => setShowSelfBuyWarning(false)}>
              {t("createYourOwnLuck.detail.selfBuyWarningCancel")}
            </button>
            <button className="cyol-submit" onClick={confirmSelfBuy}>
              {t("createYourOwnLuck.detail.selfBuyWarningConfirm")}
            </button>
          </div>
        </div>
      </div>
    )}

    {showBuyValueWarning && buyWorstCaseShareUsd !== null && (
      <ValueMismatchWarningModal
        bodyText={t("createYourOwnLuck.detail.valueMismatchBuyBody", {
          shareUsd: buyWorstCaseShareUsd.toFixed(2),
          ticketUsd: ticketPriceUsd.toFixed(2),
        })}
        onCancel={() => setShowBuyValueWarning(false)}
        onConfirm={confirmBuyValueWarning}
      />
    )}

    {showFundValueWarning && fundWorstCaseShareUsd !== null && (
      <ValueMismatchWarningModal
        bodyText={t("createYourOwnLuck.detail.valueMismatchFundBody", {
          shareUsd: fundWorstCaseShareUsd.toFixed(2),
          ticketUsd: ticketPriceUsd.toFixed(2),
        })}
        onCancel={() => setShowFundValueWarning(false)}
        onConfirm={confirmFundValueWarning}
      />
    )}
    </>
  );
}
