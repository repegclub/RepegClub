import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "../../styles/wheel.css";
import "../../styles/cyol.css";
import { GameNav } from "../Shared/GameNav";
import { ConnectWalletButton } from "../Wallet/ConnectWalletButton";
import { NetworkBadge } from "../Wallet/NetworkBadge";
import { WalletBalance } from "../Wallet/WalletBalance";
import { useWallet } from "../../contexts/WalletContext";
import { useCyolRaffleDetail } from "../../hooks/useCyolRaffleDetail";
import { useCyolRaffleIndex } from "../../hooks/useCyolRaffleIndex";
import { displayNumberToUluna, ulunaToDisplayNumber } from "../../lib/format";
import { prizeCurrencyLabel, formatAmount } from "../../lib/cyolFormat";
import { worstCaseTicketRevenueProfit } from "../../lib/cyolFundingDisclosure";
import { walletConcentration, concentrationBand } from "../../lib/cyolChecklist";
import { useTokenPrices } from "../../hooks/useTokenPrices";
import { priceForDenom, priceForAsset } from "../../lib/tokenPrices";
import { participantsWord, statusLabelKey } from "../../lib/cyolTerminology";
import { PRIZE_ASSET_LABELS } from "../../lib/cyolPrizeDenoms";
import { getCachedPrizeAssetChoice } from "../../lib/cyolPrizeAssetCache";
import { getCw20Blacklisted, getCw20Whitelisted } from "../../lib/queryFactory";
import { CyolSafetyChecklist } from "./CyolSafetyChecklist";
import {
  depositPrize,
  payServiceFee,
  buyTickets,
  withdrawTicket,
  closeRound,
  claimAirdropShare,
  claimExpiredRaffle,
  finalizeExpireClosedRaffle,
  reclaimUnclaimed,
  cancelRaffle,
  expireRaffle,
  requestExpireClosedRaffle,
  retryPrizePayout,
} from "../../lib/cyolActions";
import { friendlyCyolError } from "../../lib/cyolErrorMessages";
import { CyolVerifyPanel } from "./CyolVerifyPanel";
import { usePollWhileClosed } from "../../hooks/usePollWhileClosed";
import { CyolRevealWheel } from "./CyolRevealWheel";
import { CyolRevealChest } from "./CyolRevealChest";

// Mirrors MAX_RAFFLE_AGE_SECONDS exactly (contracts/create-your-own-luck/
// src/contract.rs) - fixed platform-wide since the 2026-08-20 soft-close
// redesign, no longer a per-raffle field the contract's GetConfig returns
// (round-7 audit fix: this page used to read config.max_raffle_age_seconds,
// which is undefined now - ageReached below silently evaluated to false
// forever, hiding the one permissionless rescue path for a stalled raffle).
const MAX_RAFFLE_AGE_SECONDS = 5_184_000; // 60 days

// Mirrors contract::MAX_REVEAL_AGE_SECONDS exactly (contracts/create-your-own-luck/
// src/contract.rs) - fixed platform-wide, not creator-chosen or exposed via
// GetConfig, same treatment as MAX_RAFFLE_AGE_SECONDS above.
const MAX_REVEAL_AGE_SECONDS = 3_600; // 1 hour

// Mirrors max_tickets_per_wallet exactly (contracts/create-your-own-luck/
// src/execute.rs) - lets the UI cap a batch purchase client-side instead of
// letting a wallet type a number the contract is guaranteed to reject
// (which would revert the whole batched transaction, not just the excess).
function maxTicketsPerWallet(raffleType: string, maxPlayers: number, ticketPrice: string): number {
  if (ticketPrice === "0") return 1;
  if (raffleType === "airdrop") return 1;
  return Math.max(1, Math.floor(maxPlayers / 2));
}

// Hours/minutes is plenty for a window on the order of an hour - unlike
// Wheel of Repeg's own countdown (WheelCard.tsx's formatCountdown), this
// doesn't need second-precision live ticking, so it's fine that it only
// refreshes with the rest of raffleStatus (every 12s while Open).
function formatDuration(totalSeconds: number): string {
  // Sub-minute values used to floor to "0m" for up to 59 real seconds
  // (CodeRabbit finding, PR #39) - only reachable in the last minute before
  // a closing-window deadline, but a creator watching the countdown tick
  // down to "0m" and stay there for almost a minute reads as broken.
  if (totalSeconds < 60) return `${Math.max(0, Math.ceil(totalSeconds))}s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type ActionKey =
  | "fund"
  | "buy"
  | "withdraw"
  | "close"
  | "claim"
  | "reclaim"
  | "cancel"
  | "expire"
  | "retryPayout"
  | "requestRescue"
  | "finalizeRescue"
  | "claimRescue";

// Shared by both the buyer-side and creator-side value-mismatch warnings
// below (security catalog's hallazgo #6, 2026-07-25/26): unlike the
// self-buy warning's simple confirm/cancel, this one requires an explicit
// checkbox before the confirm button becomes clickable - a real financial
// decision (paying more than you'd get back, or shortchanging your own
// participants), not just a reputational nudge.
function ValueMismatchWarningModal({
  bodyText,
  titleKey = "createYourOwnLuck.detail.valueMismatchWarningTitle",
  checkboxKey = "createYourOwnLuck.detail.valueMismatchWarningCheckbox",
  onCancel,
  onConfirm,
}: {
  bodyText: string;
  titleKey?: string;
  checkboxKey?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  return (
    <div className="history-overlay" onClick={onCancel}>
      <div className="history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="history-modal-header">
          <h2 className="history-modal-title">{t(titleKey)}</h2>
          <button type="button" className="history-close-btn" onClick={onCancel}>
            ✕
          </button>
        </div>
        <p className="cyol-modal-body-text">{bodyText}</p>
        <label className="cyol-checkbox-label">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {t(checkboxKey)}
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
  const routerState = location.state as { plannedPrizeAmount?: string } | null;
  const plannedPrizeAmount = routerState?.plannedPrizeAmount;
  // Cached at creation time (see cyolPrizeAssetCache.ts), unlike
  // plannedPrizeAmount above - this feeds real safety calculations (the
  // value-mismatch warnings, the safety checklist), so it needs to survive
  // a reload/revisit, not just the initial redirect after creating.
  const cachedPrizeAssetChoice = getCachedPrizeAssetChoice(address);
  const [prizeAmount, setPrizeAmount] = useState(plannedPrizeAmount ?? "100");
  const [ticketQuantity, setTicketQuantity] = useState("1");
  const [actionBusy, setActionBusy] = useState<ActionKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  const [showSelfBuyWarning, setShowSelfBuyWarning] = useState(false);
  const [showBuyValueWarning, setShowBuyValueWarning] = useState(false);
  const [showSingleWinnerPrizeWarning, setShowSingleWinnerPrizeWarning] = useState(false);
  const [showSingleWinnerBuyerPrizeWarning, setShowSingleWinnerBuyerPrizeWarning] = useState(false);
  const [showAirdropFundValueWarning, setShowAirdropFundValueWarning] = useState(false);
  const [showCancelPenaltyWarning, setShowCancelPenaltyWarning] = useState(false);
  // Holds the freshly-fetched bps handleCancelRaffle computed right before
  // opening this modal, when that differs from the page's own (possibly
  // stale) snapshot - CodeRabbit finding, 2026-08-23: the earlier fix called
  // `detail.refetch()` unawaited to sync the snapshot, but confirming can
  // happen before that resolves, so the modal could briefly show 0%/$0.00
  // while a real penalty was about to be charged. `null` means "use the
  // render-time cancelPenaltyBps/cancelForfeitedUsd", the common case.
  const [cancelPenaltyBpsOverride, setCancelPenaltyBpsOverride] = useState<number | null>(null);
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

  // Nothing else refetches once Closed (found live-testing, 2026-08-31) - a
  // wallet sitting on this page after buying the ticket that filled the
  // raffle saw "waiting for the winner to be revealed" forever, since the
  // effect above only polls while "open". The keeper usually reveals within
  // one of its own ~15s cycles - this just needs to notice when it does.
  usePollWhileClosed(raffleOpenStatus === "closed", detail.refetch);

  // isAirdropParam (not a closure over the component's own `isAirdrop`,
  // which - see below - isn't computed until after `config` loads):
  // shell() is also used by the loading/error/podium-unsupported early
  // returns above, before the raffle's own type is known at all, so those
  // call sites default to the generic wording (mirrors createYourOwnLuck
  // vs createYourOwnLuck.raffleType elsewhere - "raffle" as the fallback
  // when a distinction can't be made yet). Only the real, loaded render at
  // the bottom of this component passes the true value.
  const shell = (children: React.ReactNode, isAirdropParam = false) => (
    <main className="wheel-page cyol-page">
      <div className="wallet-bar">
        <GameNav current="/create-your-own-luck" />
        <div className="wallet-bar-right">
          <div className="wallet-status-group">
            <NetworkBadge />
            <ConnectWalletButton />
          </div>
          {/* Wallet balance, not game data - belongs on every page, same as
              Wheel of Repeg/Weekly Round/the CYOL list page (see
              .wallet-bar-secondary there). */}
          <div className="wallet-bar-secondary">
            <WalletBalance />
          </div>
        </div>
      </div>
      <Link className="cyol-back-link" to="/create-your-own-luck">
        {t(isAirdropParam ? "createYourOwnLuck.detail.backAirdrop" : "createYourOwnLuck.detail.back")}
      </Link>
      {children}
    </main>
  );

  if (detail.status === "loading") return shell(<p>{t("createYourOwnLuck.loading")}</p>);
  if (detail.status === "error") return shell(<p className="cyol-form-error">{t("createYourOwnLuck.cardError")}</p>);

  const { config, raffleStatus, winners, myAirdropShare, myTicketCount, entrants, cancellationPenaltyWaivedByPlatformRevocation } =
    detail;

  if (config.raffle_type === "podium") {
    return shell(<p className="cyol-form-error">{t("createYourOwnLuck.detail.podiumUnsupported")}</p>);
  }

  const prizeDenom = "native" in config.prize_asset ? config.prize_asset.native.denom : null;
  const isAirdrop = config.raffle_type === "airdrop";
  const isCreator = walletAddress !== null && walletAddress === config.creator;
  const connected = walletState.status === "connected";
  const busy = actionBusy !== null;

  // Value-mismatch checks (security catalog's hallazgo #6): a paid raffle's
  // ticket is always USDC (~$1), but the prize can be any of LUNC/USDC/USTC.
  // Only meaningful for a paid raffle (a free one risks nothing).
  const isPaid = config.ticket_price !== "0";
  const ticketPriceUsd = ulunaToDisplayNumber(config.ticket_price);
  // Real gap found live-testing (2026-07-26): the label fix above only
  // covered the display text - this is the actual VALUE used by the
  // value-mismatch gates below, which is what actually matters. Without
  // preferring the cached real choice here too, a LUNC-prized raffle would
  // silently price itself as USDC ($1/unit), defeating the exact warning
  // this is meant to trigger.
  const prizeAssetPrice =
    cachedPrizeAssetChoice && tokenPrices.status === "loaded"
      ? priceForAsset(cachedPrizeAssetChoice, tokenPrices.prices)
      : prizeDenom && tokenPrices.status === "loaded"
        ? priceForDenom(prizeDenom, tokenPrices.prices)
        : null;
  const fundedPrizeUsd =
    prizeAssetPrice !== null && raffleStatus.prize_amount !== "0"
      ? ulunaToDisplayNumber(raffleStatus.prize_amount) * prizeAssetPrice
      : null;
  const buyWorstCaseShareUsd = fundedPrizeUsd !== null ? fundedPrizeUsd / config.max_players : null;
  const buyValueMismatch = isAirdrop && isPaid && buyWorstCaseShareUsd !== null && buyWorstCaseShareUsd < ticketPriceUsd;
  // Round-8 audit fix: same silent-skip gap fundValueUnknown closed on the
  // funding side (see its own comment) - a failed/slow price feed made
  // buyWorstCaseShareUsd null, buyValueMismatch false, and handleBuyTicket
  // proceeded with zero disclosure to a buyer about to pay into a possibly-
  // unfair Airdrop. This one was never backed by an on-chain block (buyer-
  // side fairness was always frontend-only), so it's not a regression from
  // round 6/7 the way the funding-side one was - but the same "silence
  // isn't a substitute for disclosure" reasoning applies.
  const buyValueUnknown = isAirdrop && isPaid && prizeAssetPrice === null && raffleStatus.prize_amount !== "0";

  const plannedPrizeNum = Number(prizeAmount);
  const plannedPrizeUsd =
    prizeAssetPrice !== null && Number.isFinite(plannedPrizeNum) ? plannedPrizeNum * prizeAssetPrice : null;

  // Airdrop: each wallet's guaranteed share vs the ticket - if it's worth
  // less, someone's paying more than they'll get back, even in the best
  // case (SingleWinner/Podium's prize-vs-TOTAL-ticket-revenue mismatch is
  // normal lottery variance, already covered by the fundraiser disclosure -
  // this is a different, guaranteed-payout question).
  const fundWorstCaseShareUsd = plannedPrizeUsd !== null ? plannedPrizeUsd / config.max_players : null;
  const fundValueMismatch = isAirdrop && isPaid && fundWorstCaseShareUsd !== null && fundWorstCaseShareUsd < ticketPriceUsd;
  // Round-7 audit fix: this warning is the ONLY fairness safeguard left for
  // a paid Airdrop's prize (the on-chain floor that used to back it up was
  // removed - see execute_receive's own doc comment in the contract). Before
  // this fix, a failed/slow price fetch (tokenPrices' own doc comment notes
  // CoinGecko errors are deliberately silent, `status: "error"`) made
  // fundWorstCaseShareUsd null, which made fundValueMismatch false, which
  // let handleFund skip straight to funding with NO disclosure at all - an
  // honest creator using the real UI got none of the protection this page
  // is supposed to provide. Distinct from fundValueMismatch (which means
  // "we know the value and it's unfair") - this means "we can't tell".
  const fundValueUnknown = isAirdrop && isPaid && prizeAssetPrice === null && plannedPrizeNum > 0;

  // SingleWinner: the ENTIRE prize vs a single ticket - categorically
  // different from "normal lottery variance" (which is about total ticket
  // revenue vs the prize, not this): no winner could ever receive less than
  // what they paid for one ticket, regardless of odds, while the creator's
  // own ticket revenue always refunds to them regardless of who wins. Real
  // case found live-testing 2026-07-26: a 100 LUNC prize (worth ~$0.005)
  // against a $1 ticket - the creator can only gain, the buyer has already
  // lost before the raffle even starts.
  const singleWinnerPrizeBelowTicket =
    !isAirdrop && isPaid && plannedPrizeUsd !== null && plannedPrizeUsd < ticketPriceUsd;
  // Round-9 audit fix: same silent-skip gap fundValueUnknown/buyValueUnknown
  // closed for Airdrop (rounds 7/8) - a failed/slow price feed left
  // plannedPrizeUsd null, singleWinnerPrizeBelowTicket false, and handleFund
  // proceeded with zero disclosure. Mirrors fundValueUnknown's own reasoning.
  const singleWinnerPrizeUnknown = !isAirdrop && isPaid && prizeAssetPrice === null && plannedPrizeNum > 0;

  const singleWinnerBuyerPrizeBelowTicket =
    !isAirdrop && isPaid && fundedPrizeUsd !== null && fundedPrizeUsd < ticketPriceUsd;
  const singleWinnerBuyerPrizeUnknown =
    !isAirdrop && isPaid && prizeAssetPrice === null && raffleStatus.prize_amount !== "0";

  const hasMin = raffleStatus.unique_player_count >= config.min_players;
  const reachedMax = raffleStatus.unique_player_count >= config.max_players;
  const timeoutElapsed = raffleStatus.seconds_remaining !== null && raffleStatus.seconds_remaining <= 0;
  const ageReached = raffleStatus.opened_at !== null && nowSec >= raffleStatus.opened_at + MAX_RAFFLE_AGE_SECONDS;
  // Mirrors execute_request_expire_closed_raffle's own condition exactly
  // (closed_at + MAX_REVEAL_AGE_SECONDS) - the 3-phase outage safety net for
  // a Closed raffle the keeper hasn't revealed, same as wheel-manager/
  // weekly-round's matching cards.
  const stuckEligible =
    raffleStatus.status === "closed" &&
    raffleStatus.closed_at !== null &&
    nowSec >= raffleStatus.closed_at + MAX_REVEAL_AGE_SECONDS;

  const canFund = isCreator && raffleStatus.status === "funding" && prizeDenom !== null;
  const canBuyTicket = raffleStatus.status === "open";
  const ticketCap = maxTicketsPerWallet(config.raffle_type, config.max_players, config.ticket_price);
  const maxMoreTickets = Math.max(0, ticketCap - (myTicketCount ?? 0));
  // Airdrop is exempt from the min_players lock entirely (2026-08-23 fix,
  // execute.rs's execute_withdraw_ticket) - there's no draw to protect,
  // just a deterministic prize/unique_players split, so a participant can
  // always leave before the airdrop closes instead of being trapped in a
  // guaranteed-loss share by whoever happened to buy after them.
  const canWithdrawTicket = raffleStatus.status === "open" && (isAirdrop || !hasMin);
  const canCloseRound =
    raffleStatus.status === "open" && (reachedMax || (timeoutElapsed && hasMin) || (isCreator && hasMin));
  const canExpireRaffle = raffleStatus.status === "open" && !hasMin && ageReached;
  const canCancelRaffle = isCreator && (raffleStatus.status === "funding" || raffleStatus.status === "open");
  // Round-8 audit fix: mirrors execute_cancel_raffle's own penalty formula
  // (contracts/create-your-own-luck/src/execute.rs) - always 0 for Airdrop
  // (base/late bps are hardcoded 0/0 at instantiate, see Config's own doc
  // comment), base_bps once the fee is paid, base+late_additional once
  // min_players is reached. Without this, Cancel had no confirmation at all
  // (unlike every other consequential action on this page) - a creator
  // could forfeit up to 100% of the service fee with zero warning, and a
  // factory-side comment incorrectly implied a "fund-time disclaimer
  // checkbox" already covered this (it didn't - nothing on this page ever
  // showed the penalty bps at all).
  // Round-9 audit fix (Opus): the contract's penalty_amount is
  // `raffle.fee_amount * penalty_bps / 10000`, and raffle.fee_amount is 0
  // until PayServiceFee/the same-denom fund path pays it - so a penalty
  // shown before that point overstated what cancelling would actually cost
  // (nothing).
  // Round-10 audit fix (Fable + Opus, independently): mirrors
  // cancellation_penalty_waived_by_platform_revocation - a CW20-prized
  // raffle still Funding with nothing deposited, whose token the platform
  // blacklisted or de-whitelisted out from under the creator, is also
  // charged 0 on-chain (see useCyolRaffleDetail.ts's own comment for the
  // live query this mirrors).
  // Extracted so handleCancelRaffle can recompute this with a freshly
  // fetched `waived` right before deciding whether to warn (CodeRabbit
  // finding, 2026-08-23) - `cancellationPenaltyWaivedByPlatformRevocation`
  // itself is only ever as fresh as the last page load/refetch, and the
  // 12s poll above only runs while status is "open", not "funding" (the
  // only status this waiver is ever relevant for). A page left open on a
  // stale "not waived" snapshot after the factory revokes the CW20 mid-
  // session would only over-warn (harmless) - but a stale "waived" snapshot
  // after an admin correction would skip the warning entirely and cancel
  // with a real, uncommunicated forfeit, which is the direction worth
  // closing.
  const cancelPenaltyBpsForWaiver = (waived: boolean) =>
    isAirdrop || !raffleStatus.fee_paid || waived
      ? 0
      : hasMin
        ? config.cancellation_penalty_base_bps + config.cancellation_penalty_late_additional_bps
        : config.cancellation_penalty_base_bps;
  const cancelPenaltyBps = cancelPenaltyBpsForWaiver(cancellationPenaltyWaivedByPlatformRevocation);
  const cancelForfeitedUsdForBps = (bps: number) => (ulunaToDisplayNumber(config.fee_amount_usdc) * bps) / 10000;
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
    // Was a hard block until 2026-08-21 (direct request, 2026-08-20) - the
    // matching on-chain block was found unsound for any non-USDC prize
    // (LUNC/USTC/whitelisted CW20 all have real value per unit different
    // from USDC's 1:1 assumption, and there's no price oracle on-chain to
    // convert - this project has twice already rejected building one,
    // manipulable without a TWAP). Explicit product decision: same
    // disclosure + reputation mitigation as this contract's other
    // creator-fairness findings (self-dealing, late cancellation) instead
    // of a contract-level block that would either be wrong or foreclose
    // the whitelisted-CW20-reward use case (a project rewarding paid-ticket
    // supporters with its own token) entirely. See execute_receive's own
    // doc comment in the contract for the full reasoning.
    if (fundValueMismatch || fundValueUnknown) {
      setShowAirdropFundValueWarning(true);
      return;
    }
    if (singleWinnerPrizeBelowTicket || singleWinnerPrizeUnknown) {
      setShowSingleWinnerPrizeWarning(true);
      return;
    }
    runFund();
  }
  function confirmAirdropFundValueWarning() {
    setShowAirdropFundValueWarning(false);
    runFund();
  }
  function confirmSingleWinnerPrizeWarning() {
    setShowSingleWinnerPrizeWarning(false);
    runFund();
  }
  function runBuyTicket() {
    if (walletState.status !== "connected") return;
    if (maxMoreTickets < 1) {
      setActionError(
        t(isAirdrop ? "createYourOwnLuck.detail.ticketCapReachedAirdrop" : "createYourOwnLuck.detail.ticketCapReached", {
          cap: ticketCap,
        })
      );
      return;
    }
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
    if (buyValueMismatch || buyValueUnknown) {
      setShowBuyValueWarning(true);
      return;
    }
    if (singleWinnerBuyerPrizeBelowTicket || singleWinnerBuyerPrizeUnknown) {
      setShowSingleWinnerBuyerPrizeWarning(true);
      return;
    }
    runBuyTicket();
  }
  function confirmSelfBuy() {
    setShowSelfBuyWarning(false);
    if (buyValueMismatch || buyValueUnknown) {
      setShowBuyValueWarning(true);
      return;
    }
    if (singleWinnerBuyerPrizeBelowTicket || singleWinnerBuyerPrizeUnknown) {
      setShowSingleWinnerBuyerPrizeWarning(true);
      return;
    }
    runBuyTicket();
  }
  function confirmBuyValueWarning() {
    setShowBuyValueWarning(false);
    runBuyTicket();
  }
  function confirmSingleWinnerBuyerPrizeWarning() {
    setShowSingleWinnerBuyerPrizeWarning(false);
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
  function handleClaimAirdrop() {
    if (walletState.status !== "connected") return;
    run("claim", () => claimAirdropShare(walletState.wallet, address));
  }
  function handleReclaimUnclaimed() {
    if (walletState.status !== "connected") return;
    run("reclaim", () => reclaimUnclaimed(walletState.wallet, address));
  }
  async function handleCancelRaffle() {
    if (walletState.status !== "connected") return;
    let penaltyBps = cancelPenaltyBps;
    // Refetch the waiver fresh right before deciding, rather than trusting
    // the page's load-time snapshot (see cancelPenaltyBpsForWaiver's own
    // comment) - same CW20-prized-and-still-Funding gate the query itself
    // uses, so this never fires an extra round trip for the common case.
    const cw20Address = "cw20" in config.prize_asset ? config.prize_asset.cw20.address : null;
    if (cw20Address && raffleStatus.status === "funding" && raffleStatus.prize_amount === "0") {
      const blacklisted = await getCw20Blacklisted(cw20Address, config.factory_address).catch(() => false);
      const whitelisted = blacklisted
        ? true
        : config.ticket_price !== "0"
          ? await getCw20Whitelisted(cw20Address, config.factory_address).catch(() => true)
          : true;
      const waived = blacklisted || !whitelisted;
      penaltyBps = cancelPenaltyBpsForWaiver(waived);
      // Sync the page's own snapshot in the background too (not awaited) -
      // keeps cancellationPenaltyWaivedByPlatformRevocation from lagging
      // behind for any later render (e.g. if this dialog gets cancelled and
      // reopened). Not what the modal itself relies on for correctness
      // though - see cancelPenaltyBpsOverride's own comment for why.
      if (waived !== cancellationPenaltyWaivedByPlatformRevocation) detail.refetch();
    }
    if (penaltyBps > 0) {
      // CodeRabbit finding, 2026-08-23: store the exact bps just computed,
      // not just the render-time cancelPenaltyBps - the unawaited
      // detail.refetch() above can't be relied on to land before the user
      // confirms, so without this override the modal could show 0%/$0.00
      // while about to charge a real penalty.
      setCancelPenaltyBpsOverride(penaltyBps);
      setShowCancelPenaltyWarning(true);
      return;
    }
    run("cancel", () => cancelRaffle(walletState.wallet, address));
  }
  function confirmCancelPenaltyWarning() {
    setShowCancelPenaltyWarning(false);
    setCancelPenaltyBpsOverride(null);
    if (walletState.status !== "connected") return;
    run("cancel", () => cancelRaffle(walletState.wallet, address));
  }
  function handleExpireRaffle() {
    if (walletState.status !== "connected") return;
    run("expire", () => expireRaffle(walletState.wallet, address));
  }
  // 3-phase outage safety net for a Closed raffle the keeper hasn't revealed
  // - see lib/cyolActions.ts. Discreet by design: only stuckEligible gates
  // Request/Finalize visibility, and the contract's own rejection (e.g.
  // "finalize delay has not cleared yet") surfaces as-is via
  // friendlyCyolError if a step is tried before it's actually ready.
  function handleRequestExpireClosedRaffle() {
    if (walletState.status !== "connected") return;
    run("requestRescue", () => requestExpireClosedRaffle(walletState.wallet, address));
  }
  function handleFinalizeExpireClosedRaffle() {
    if (walletState.status !== "connected") return;
    run("finalizeRescue", () => finalizeExpireClosedRaffle(walletState.wallet, address));
  }
  function handleClaimExpiredRaffle() {
    if (walletState.status !== "connected") return;
    run("claimRescue", () => claimExpiredRaffle(walletState.wallet, address));
  }
  // Permissionless (round-10 audit fix) - visible to anyone, not just the
  // winner, since the underlying RetryPrizePayout is: an honest transfer
  // failure shouldn't require the specific winner to be the one to notice
  // and act.
  function handleRetryPrizePayout() {
    if (walletState.status !== "connected") return;
    run("retryPayout", () => retryPrizePayout(walletState.wallet, address));
  }

  // Real bug found live-testing (2026-07-26, raffle #17): a LUNC-chosen
  // prize always showed "Prize amount (USDC)" here, because uluna alone
  // can't distinguish LUNC from USDC on this testnet (see
  // cyolFormat.ts's prizeCurrencyLabel) - the fund transfer itself was
  // correct (confirmed on-chain: prize_asset.native.denom stored "uluna",
  // matching the LUNC choice), only the label was wrong. cachedPrizeAssetChoice
  // resolves the ambiguity whenever this browser created the raffle; falls
  // back to the denom-based guess otherwise, which is still correct for
  // USTC and will be correct for USDC/LUNC too once mainnet uses their real
  // distinct denoms.
  const prizeCurrency = cachedPrizeAssetChoice
    ? PRIZE_ASSET_LABELS[cachedPrizeAssetChoice]
    : prizeCurrencyLabel(prizeDenom ?? config.usdc_denom);

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
              {/* Round-11 audit fix (Opus): prize_paid is typed as always
                  present (matches the current contract), but a raffle from
                  before this field existed on-chain genuinely omits the key
                  from GetWinners' JSON response - `?.[i]`/`=== undefined`
                  guard that, same gap class useCyolRaffleDetail.ts already
                  handles for getEntrants.
                  Round-12 fix (Opus): distinguishes "field missing entirely"
                  (an old, pre-RetryPrizePayout raffle - the button below is
                  hidden for exactly this case, since that message variant
                  doesn't even exist on that code_id, so it'd only ever error)
                  from "field present, this winner is false" (a genuine
                  pending payout - the button IS available). The single
                  "pending... retry it below" copy used to cover both, which
                  was actively wrong for the first case: there was nothing
                  "below" to retry with. */}
              <p className="cyol-detail-hint">
                {winners.prize_paid === undefined
                  ? t("createYourOwnLuck.detail.prizeStatusUnknownTo", { winner })
                  : winners.prize_paid[i]
                    ? t("createYourOwnLuck.detail.prizeSentTo", { winner })
                    : t("createYourOwnLuck.detail.prizePendingTo", { winner })}
              </p>
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
        {(winners.prize_paid ?? []).some((paid) => !paid) && (
          <button
            className="cyol-submit cyol-submit-secondary"
            onClick={handleRetryPrizePayout}
            disabled={busy || !connected}
          >
            {actionBusy === "retryPayout" ? t("createYourOwnLuck.detail.retryingPayout") : t("createYourOwnLuck.detail.retryPayout")}
          </button>
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
          {t(statusLabelKey(raffleStatus.status, config.raffle_type))}
        </span>
      </div>
      <p className="cyol-detail-hint">
        {t(isAirdrop ? "createYourOwnLuck.detail.contractAddressLabelAirdrop" : "createYourOwnLuck.detail.contractAddressLabel")}
      </p>
      <p className="cyol-card-address">{address}</p>
      <p className="cyol-detail-line">{t("createYourOwnLuck.detail.creator", { creator: config.creator })}</p>
      <p className="cyol-detail-line">
        {t("createYourOwnLuck.ticketPrice", { price: formatAmount(config.ticket_price, "USDC") })}
      </p>
      <p className="cyol-detail-line">
        {t("createYourOwnLuck.players", {
          count: raffleStatus.unique_player_count,
          max: config.max_players,
          unit: participantsWord(config.raffle_type),
        })}
      </p>
      {/* The creator asked how much time they have to market this raffle
          before anyone (not just them) can close it once the minimum is
          reached - round_timeout_seconds is a fixed window from opened_at,
          already queried as seconds_remaining but never actually shown
          anywhere (2026-07-26). */}
      {/* Creator-only (direct request, 2026-08-20): publicly showing exactly
          when anyone can force-close was a real, live-found exploit angle -
          whoever's already in benefits from cutting entrants off early
          (a bigger split of a fixed Airdrop prize, or better odds against a
          smaller SingleWinner/Podium pool), so a visible countdown handed
          early participants a precise "strike now" signal against the
          creator's own marketing plan. Not a cryptographic guarantee -
          opened_at/round_timeout_seconds are public contract state, so a
          determined participant could still query the raw numbers - just no
          longer handed to a casual actor in the UI. */}
      {isCreator && raffleStatus.status === "open" && (
        // .cyol-detail-line, not .cyol-detail-hint (2026-08-23 fix, found by
        // the user) - this row reports the raffle's actual state (same tier
        // as creator/ticket price/participants/prize below), not a passive
        // instructional label like the contract-address note above it. The
        // dimmer, smaller hint style made it look visually demoted next to
        // rows carrying equally load-bearing information.
        <p className="cyol-detail-line">
          {/* seconds_remaining is null until min_players is first reached -
              query_raffle_status's own comment: "no meaningful countdown
              before that point under the soft-close design". Before this
              fix, that meant no message at all here while waiting - a
              creator with fewer than min_players couldn't tell the
              countdown was intentionally absent from one that had simply
              broken, found by the user live-testing a 3-day airdrop with
              only themselves joined so far (2026-08-23). */}
          {raffleStatus.seconds_remaining === null
            ? t(
                isAirdrop ? "createYourOwnLuck.detail.marketingWindowNotStartedAirdrop" : "createYourOwnLuck.detail.marketingWindowNotStarted",
                { min: config.min_players, unit: participantsWord(config.raffle_type) }
              )
            : raffleStatus.seconds_remaining > 0
              ? t(
                  isAirdrop ? "createYourOwnLuck.detail.marketingWindowRemainingAirdrop" : "createYourOwnLuck.detail.marketingWindowRemaining",
                  { time: formatDuration(raffleStatus.seconds_remaining) }
                )
              : t(isAirdrop ? "createYourOwnLuck.detail.marketingWindowElapsedAirdrop" : "createYourOwnLuck.detail.marketingWindowElapsed")}
        </p>
      )}
      <p className="cyol-detail-line">
        {t(
          isAirdrop ? "createYourOwnLuck.detail.totalTicketsOnePerWallet" : "createYourOwnLuck.detail.totalTickets",
          { count: raffleStatus.ticket_count }
        )}
      </p>
      {connected && myTicketCount !== null && myTicketCount > 0 && (
        <p className="cyol-detail-line cyol-detail-highlight">
          {t(isAirdrop ? "createYourOwnLuck.detail.myTicketsAirdrop" : "createYourOwnLuck.detail.myTickets", { count: myTicketCount })}
        </p>
      )}
      {raffleStatus.prize_amount !== "0" && (
        <p className="cyol-detail-line">
          {t("createYourOwnLuck.detail.prize", { prize: formatAmount(raffleStatus.prize_amount, prizeCurrency) })}
        </p>
      )}
      {/* Only USTC needs this - a LUNC-labeled prize already displays as
          "USDC" on this testnet (see prizeCurrencyLabel's own ambiguity),
          so showing a conversion next to it would just repeat the same
          number under a different name. */}
      {raffleStatus.prize_amount !== "0" && prizeCurrency === "USTC" && prizeAssetPrice !== null && (
        <p className="cyol-detail-hint">
          {t("createYourOwnLuck.detail.prizeUsdcEquivalent", {
            amount: (ulunaToDisplayNumber(raffleStatus.prize_amount) * prizeAssetPrice).toFixed(2),
          })}
        </p>
      )}
      {!prizeDenom && <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.cw20NotSupported")}</p>}

      <CyolSafetyChecklist
        config={config}
        raffleStatus={raffleStatus}
        entrants={entrants}
        prizeAssetChoiceOverride={cachedPrizeAssetChoice ?? undefined}
      />

      {actionError && <p className="cyol-form-error">{actionError}</p>}

      {raffleStatus.status === "funding" &&
        (canFund ? (
          <div className="cyol-detail-action">
            <p className="cyol-detail-hint">
              {t(isAirdrop ? "createYourOwnLuck.detail.fundHintAirdrop" : "createYourOwnLuck.detail.fundHint")}
            </p>
            <label className="cyol-field">
              <span>
                {t(isAirdrop ? "createYourOwnLuck.detail.airdropAmountLabel" : "createYourOwnLuck.detail.prizeAmountLabel", {
                  currency: prizeCurrency,
                })}
              </span>
              <input type="number" min="0" step="0.01" value={prizeAmount} onChange={(e) => setPrizeAmount(e.target.value)} />
              {config.raffle_type === "single_winner" &&
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
              {/* Airdrop never gets the fundraiser framing above (direct
                  request, 2026-08-20) - a positive "this works like a
                  fundraiser" reading here would be misleading once the Fund
                  button below is about to warn about exactly that. Same
                  worst-case-share math and copy as CreatorForm.tsx's own
                  airdrop calculator (reused verbatim, not duplicated under a
                  new key) - this is the same question asked again now that
                  the prize amount is finally real instead of just planned.
                  Was a hard block until 2026-08-21 - see handleFund's own
                  comment for why it's now a confirm-and-proceed warning
                  instead (ValueMismatchWarningModal below), same pattern as
                  every other creator-fairness warning on this page. */}
              {isAirdrop && isPaid && fundWorstCaseShareUsd !== null && (
                <div className={`cyol-airdrop-fairness-box${fundValueMismatch ? " cyol-airdrop-fairness-box-unfair" : ""}`}>
                  {t("createYourOwnLuck.form.airdropCalcWorstCase", { shareUsd: fundWorstCaseShareUsd.toFixed(2) })}{" "}
                  {t(
                    fundValueMismatch ? "createYourOwnLuck.form.airdropCalcUnfair" : "createYourOwnLuck.form.airdropCalcFair",
                    { ticketUsd: ticketPriceUsd.toFixed(2) }
                  )}
                </div>
              )}
              {/* fundValueUnknown case (round-7 audit fix): price fetch
                  failed/still loading, so fundWorstCaseShareUsd above is
                  null and that box doesn't render at all - without this,
                  the page would show nothing here and handleFund would
                  silently skip the warning modal too (see fundValueUnknown's
                  own comment). Surfaces the gap instead of hiding it. */}
              {fundValueUnknown && (
                <div className="cyol-airdrop-fairness-box cyol-airdrop-fairness-box-unfair">
                  {t("createYourOwnLuck.form.airdropCalcUnknown", { ticketUsd: ticketPriceUsd.toFixed(2) })}
                </div>
              )}
            </label>
            <button className="cyol-submit" onClick={handleFund} disabled={busy || !connected}>
              {actionBusy === "fund"
                ? t("createYourOwnLuck.detail.funding")
                : t(isAirdrop ? "createYourOwnLuck.detail.fundAirdrop" : "createYourOwnLuck.detail.fund")}
            </button>
          </div>
        ) : (
          <p className="cyol-detail-hint">
            {t(isAirdrop ? "createYourOwnLuck.detail.waitingForFundingAirdrop" : "createYourOwnLuck.detail.waitingForFunding")}
          </p>
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
                  title={
                    maxMoreTickets < 1
                      ? t(isAirdrop ? "createYourOwnLuck.detail.ticketCapReachedAirdrop" : "createYourOwnLuck.detail.ticketCapReached", {
                          cap: ticketCap,
                        })
                      : undefined
                  }
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
              {actionBusy === "expire"
                ? t("createYourOwnLuck.detail.expiring")
                : t(isAirdrop ? "createYourOwnLuck.detail.expireAirdrop" : "createYourOwnLuck.detail.expireRaffle")}
            </button>
          )}
        </div>
      )}

      {raffleStatus.status === "closed" && (
        <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.closedWaitingReveal")}</p>
      )}

      {stuckEligible && connected && (
        <div className="cyol-detail-actions">
          <button className="cyol-submit cyol-submit-secondary" onClick={handleRequestExpireClosedRaffle} disabled={busy}>
            {actionBusy === "requestRescue" ? t("createYourOwnLuck.detail.rescuing") : t("createYourOwnLuck.detail.rescueRequest")}
          </button>
          <button className="cyol-submit cyol-submit-secondary" onClick={handleFinalizeExpireClosedRaffle} disabled={busy}>
            {actionBusy === "finalizeRescue" ? t("createYourOwnLuck.detail.rescuing") : t("createYourOwnLuck.detail.rescueFinalize")}
          </button>
        </div>
      )}
      {raffleStatus.status === "expiry_pending" && connected && (
        <button className="cyol-submit" onClick={handleClaimExpiredRaffle} disabled={busy}>
          {actionBusy === "claimRescue" ? t("createYourOwnLuck.detail.rescuing") : t("createYourOwnLuck.detail.rescueClaim")}
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

      {raffleStatus.status === "cancelled" && (
        <p className="cyol-detail-hint">
          {t(isAirdrop ? "createYourOwnLuck.detail.cancelledAirdrop" : "createYourOwnLuck.detail.cancelled")}
        </p>
      )}

      {canCancelRaffle && (
        <button className="cyol-cancel-link" onClick={handleCancelRaffle} disabled={busy || !connected}>
          {actionBusy === "cancel"
            ? t("createYourOwnLuck.detail.cancelling")
            : t(isAirdrop ? "createYourOwnLuck.detail.cancelAirdrop" : "createYourOwnLuck.detail.cancelRaffle")}
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
          <p className="cyol-modal-body-text">
            {t(isAirdrop ? "createYourOwnLuck.detail.selfBuyWarningBodyAirdrop" : "createYourOwnLuck.detail.selfBuyWarningBody")}
          </p>
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

    {showBuyValueWarning && (buyWorstCaseShareUsd !== null || buyValueUnknown) && (
      <ValueMismatchWarningModal
        bodyText={
          buyValueUnknown
            ? t("createYourOwnLuck.detail.valueMismatchBuyUnknownBody", { ticketUsd: ticketPriceUsd.toFixed(2) })
            : t("createYourOwnLuck.detail.valueMismatchBuyBody", {
                shareUsd: (buyWorstCaseShareUsd ?? 0).toFixed(2),
                ticketUsd: ticketPriceUsd.toFixed(2),
              })
        }
        onCancel={() => setShowBuyValueWarning(false)}
        onConfirm={confirmBuyValueWarning}
      />
    )}

    {showCancelPenaltyWarning && (
      <ValueMismatchWarningModal
        bodyText={t("createYourOwnLuck.detail.cancelPenaltyWarningBody", {
          amount: cancelForfeitedUsdForBps(cancelPenaltyBpsOverride ?? cancelPenaltyBps).toFixed(2),
          percent: ((cancelPenaltyBpsOverride ?? cancelPenaltyBps) / 100).toString(),
        })}
        titleKey="createYourOwnLuck.detail.cancelPenaltyWarningTitle"
        checkboxKey="createYourOwnLuck.detail.cancelPenaltyWarningCheckbox"
        onCancel={() => {
          setShowCancelPenaltyWarning(false);
          setCancelPenaltyBpsOverride(null);
        }}
        onConfirm={confirmCancelPenaltyWarning}
      />
    )}

    {showAirdropFundValueWarning && (
      <ValueMismatchWarningModal
        bodyText={
          fundValueUnknown
            ? t("createYourOwnLuck.detail.valueMismatchAirdropUnknownBody", { ticketUsd: ticketPriceUsd.toFixed(2) })
            : t("createYourOwnLuck.detail.valueMismatchAirdropFundBody", { ticketUsd: ticketPriceUsd.toFixed(2) })
        }
        onCancel={() => setShowAirdropFundValueWarning(false)}
        onConfirm={confirmAirdropFundValueWarning}
      />
    )}

    {showSingleWinnerPrizeWarning && (plannedPrizeUsd !== null || singleWinnerPrizeUnknown) && (
      <ValueMismatchWarningModal
        bodyText={
          singleWinnerPrizeUnknown
            ? t("createYourOwnLuck.detail.valueMismatchSingleWinnerUnknownBody", { ticketUsd: ticketPriceUsd.toFixed(2) })
            : t("createYourOwnLuck.detail.valueMismatchSingleWinnerBody", {
                prizeUsd: (plannedPrizeUsd ?? 0).toFixed(2),
                ticketUsd: ticketPriceUsd.toFixed(2),
              })
        }
        onCancel={() => setShowSingleWinnerPrizeWarning(false)}
        onConfirm={confirmSingleWinnerPrizeWarning}
      />
    )}

    {showSingleWinnerBuyerPrizeWarning && (fundedPrizeUsd !== null || singleWinnerBuyerPrizeUnknown) && (
      <ValueMismatchWarningModal
        bodyText={
          singleWinnerBuyerPrizeUnknown
            ? t("createYourOwnLuck.detail.valueMismatchSingleWinnerBuyUnknownBody", { ticketUsd: ticketPriceUsd.toFixed(2) })
            : t("createYourOwnLuck.detail.valueMismatchSingleWinnerBuyBody", {
                prizeUsd: (fundedPrizeUsd ?? 0).toFixed(2),
                ticketUsd: ticketPriceUsd.toFixed(2),
              })
        }
        onCancel={() => setShowSingleWinnerBuyerPrizeWarning(false)}
        onConfirm={confirmSingleWinnerBuyerPrizeWarning}
      />
    )}
    </>,
    isAirdrop
  );
}
