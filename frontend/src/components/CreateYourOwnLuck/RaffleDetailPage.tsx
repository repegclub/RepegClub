import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameSwitcher } from "../Shared/GameSwitcher";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { useWallet } from "../../contexts/WalletContext";
import { useCyolRaffleDetail } from "../../hooks/useCyolRaffleDetail";
import { useCyolRaffleIndex } from "../../hooks/useCyolRaffleIndex";
import { displayNumberToUluna } from "../../lib/format";
import { prizeCurrencyLabel, formatAmount } from "../../lib/cyolFormat";
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

// The full raffle lifecycle, built to be testable first: buttons show up
// within their coarse status window (Open, Closed, ...) and the contract's
// own validation is the source of truth for the fine-grained eligibility
// (draw window height, unclaimed deadline, rearm cap) - its rejection
// message surfaces as-is instead of this page trying to precompute exact
// countdowns for all of them. No wheel-spin reveal yet either - plain text,
// same reasoning: prove the loop works end-to-end before investing in the
// anti-spoiler choreography Wheel of Repeg/Weekly Round already have.
export function RaffleDetailPage() {
  const { t } = useTranslation();
  const { address = "" } = useParams<{ address: string }>();
  const { state: walletState } = useWallet();
  const walletAddress = walletState.status === "connected" ? walletState.wallet.address : null;
  const detail = useCyolRaffleDetail(address, walletAddress);
  const raffleIndex = useCyolRaffleIndex(address);

  const [prizeAmount, setPrizeAmount] = useState("100");
  const [ticketQuantity, setTicketQuantity] = useState("1");
  const [actionBusy, setActionBusy] = useState<ActionKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);

  useEffect(() => {
    const id = setInterval(() => setNowSec(Date.now() / 1000), 5000);
    return () => clearInterval(id);
  }, []);

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

  const { config, raffleStatus, winners, myAirdropShare, myTicketCount } = detail;

  if (config.raffle_type === "podium") {
    return shell(<p className="cyol-form-error">{t("createYourOwnLuck.detail.podiumUnsupported")}</p>);
  }

  const prizeDenom = "native" in config.prize_asset ? config.prize_asset.native.denom : null;
  const isAirdrop = config.raffle_type === "airdrop";
  const isCreator = walletAddress !== null && walletAddress === config.creator;
  const connected = walletState.status === "connected";
  const busy = actionBusy !== null;

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

  function handleFund() {
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
  function handleBuyTicket() {
    if (walletState.status !== "connected") return;
    const quantity = Math.min(Math.max(1, Math.floor(Number(ticketQuantity)) || 1), maxMoreTickets);
    run("buy", () =>
      buyTickets(walletState.wallet, address, config.ticket_denom, config.ticket_price, quantity)
    );
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

  return shell(
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
        {t("createYourOwnLuck.detail.totalTickets", { count: raffleStatus.ticket_count })}
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

      {actionError && <p className="cyol-form-error">{actionError}</p>}

      {raffleStatus.status === "funding" &&
        (canFund ? (
          <div className="cyol-detail-action">
            <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.fundHint")}</p>
            <label className="cyol-field">
              <span>{t("createYourOwnLuck.detail.prizeAmountLabel", { currency: prizeCurrency })}</span>
              <input type="number" min="0" step="0.01" value={prizeAmount} onChange={(e) => setPrizeAmount(e.target.value)} />
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
            <button className="cyol-submit cyol-submit-secondary" onClick={handleCloseRound} disabled={busy || !connected}>
              {actionBusy === "close" ? t("createYourOwnLuck.detail.closing") : t("createYourOwnLuck.detail.closeRound")}
            </button>
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
          {!isAirdrop && winners && winners.winners.length > 0 && (
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
          )}
          {isAirdrop && myAirdropShare && (
            <p className="cyol-detail-line">
              {myAirdropShare.claimed
                ? t("createYourOwnLuck.detail.airdropClaimed")
                : t("createYourOwnLuck.detail.airdropShare", { share: formatAmount(myAirdropShare.share, prizeCurrency) })}
            </p>
          )}
          {canClaimAirdrop && (
            <button className="cyol-submit" onClick={handleClaimAirdrop} disabled={busy || !connected}>
              {actionBusy === "claim" ? t("createYourOwnLuck.detail.claiming") : t("createYourOwnLuck.detail.claimAirdrop")}
            </button>
          )}
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
  );
}
