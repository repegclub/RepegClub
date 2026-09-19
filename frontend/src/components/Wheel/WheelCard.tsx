import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { buildArcs, buildPlaceholderArcs, type Entrant } from "../../lib/wheelData";
import { useWheelSpin } from "../../hooks/useWheelSpin";
import { PixelWheelCanvas } from "./PixelWheelCanvas";
import { drawPixelWheel } from "../../lib/drawPixelWheel";
import type { WheelRoundState } from "../../hooks/useWheelRound";
import { PRIZE_SHARE } from "../../lib/queryWheelManager";
import { formatUluna } from "../../lib/format";
import { useWallet } from "../../contexts/WalletContext";
import {
  claimExpiredRound,
  closeRound,
  expireRound,
  finalizeExpireClosedRound,
  reclaimTicket,
  requestExpireClosedRound,
  withdrawTicket,
} from "../../lib/roundActions";
import { markRevealed } from "../../lib/revealCache";
import { friendlyRoundError } from "../../lib/roundErrorMessages";
import { WHEEL_MANAGER_ADDRESS } from "../../lib/deployment";
import { VerifyRoundPanel } from "./VerifyRoundPanel";
import { RedeemBox } from "./RedeemBox";
import { HostGuide } from "./HostGuide";

type WheelCardProps = {
  roundState: WheelRoundState & { refetch: () => void };
  entrants: Entrant[];
  contractAddress?: string;
  // Bumped by the parent every time a purchase succeeds - the only way this
  // component finds out (the buy action itself lives in a sibling
  // component), needed to clear "just withdrew" once a fresh ticket makes
  // that note stale.
  purchaseVersion?: number;
  onRoundFinished: (roundId: number) => void;
  onContinue: () => void;
  onEntrantsChanged?: () => void;
  onRedeemed?: () => void;
  onWithdrawn?: () => void;
  // Fired once the spin animation actually lands and shows a result -
  // lets MyWinningsPanel know it's safe to start showing this round now
  // (see lib/revealCache.ts), since it has no other way to notice.
  onRevealed?: () => void;
  // Pins the view to a past round (see WheelOfRepeg's viewRoundId) - used
  // for the "check the round you might have missed" button below. Until a
  // wallet reveals a win on the wheel, MyWinningsPanel stays silent about
  // it (no spoilers), so this button is the ONLY way to ever reach it -
  // has to read as an inviting, unmissable game action, not a footnote.
  onViewRound?: (roundId: number) => void;
  // True while roundState is pinned to a past round (see WheelOfRepeg's
  // viewRoundId) rather than showing whatever's actually live - lets a
  // wallet that didn't play this round skip straight back to the live one
  // without having to reveal/verify a result it has no stake in.
  isViewingHistory?: boolean;
};

export function WheelCard({
  roundState,
  entrants,
  contractAddress,
  purchaseVersion,
  onRoundFinished,
  onContinue,
  onEntrantsChanged,
  onRedeemed,
  onWithdrawn,
  onRevealed,
  onViewRound,
  isViewingHistory,
}: WheelCardProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const [actionBusy, setActionBusy] = useState<
    | "idle"
    | "closing"
    | "expiring"
    | "reclaiming"
    | "withdrawing"
    | "requestingRescue"
    | "finalizingRescue"
    | "claimingRescue"
  >("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [justReclaimed, setJustReclaimed] = useState(false);
  const [justWithdrawn, setJustWithdrawn] = useState(false);
  // Whether Request has already landed for the current round - the query
  // never exposed expire_requested_at_height (see the "Verificación pública
  // del sorteo" project note), so this is best-effort local tracking, not a
  // read of real on-chain state: set on a successful Request, or on a
  // redundant one that the contract itself rejects as already-pending (a
  // refresh mid-rescue re-arms this to false, and the very next click just
  // gets the same rejection and re-syncs it - never a stuck/wrong button).
  // Combined with the Request button into one below, per direct request
  // (2026-09-18) after the drill made the always-2-buttons layout confusing.
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  // Wall-clock time Request landed, for a Finalize countdown - same
  // approximation trade-off as requestSubmitted itself (a few seconds of
  // broadcast/confirm latency, and unknown after a page refresh mid-rescue,
  // in which case Finalize just shows no countdown and falls back to the
  // discreet contract-rejects-if-early pattern, same as before this existed
  // at all). EXPIRE_FINALIZE_DELAY_BLOCKS (100 blocks) converted via this
  // chain's own ~6s block time, same estimate already used throughout this
  // project's mainnet drill notes.
  const [requestSubmittedAt, setRequestSubmittedAt] = useState<number | null>(null);
  const FINALIZE_DELAY_SECONDS = 100 * 6;
  // Same approximation, third phase - EXPIRE_CHALLENGE_BLOCKS (100) +
  // REVEAL_PRIORITY_MARGIN_BLOCKS (20) blocks (contracts/wheel-manager/src/
  // execute.rs), same ~6s block time.
  const [finalizeSubmittedAt, setFinalizeSubmittedAt] = useState<number | null>(null);
  const CLAIM_DELAY_SECONDS = (100 + 20) * 6;
  // RedeemBox opens as a popup instead of inline - inline, its amount
  // input/balance/confirm stack made this card grow tall enough to
  // stretch (and visibly distort) the lab-screen image next to it.
  const [isRedeemOpen, setIsRedeemOpen] = useState(false);

  useEffect(() => {
    if (!isRedeemOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsRedeemOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isRedeemOpen]);

  // A new round means any earlier rescue attempt was for a different round
  // entirely - without this, requestSubmitted from a rescued round 2 would
  // wrongly carry over and skip straight to "Finalize rescue" if round 5
  // later got stuck too.
  const currentRoundId = roundState.status === "loaded" ? roundState.round.round_id : null;
  useEffect(() => {
    setRequestSubmitted(false);
    setRequestSubmittedAt(null);
    setFinalizeSubmittedAt(null);
  }, [currentRoundId]);

  // A fresh purchase makes any earlier "just withdrew/reclaimed" note stale
  // - without this, buying a new ticket after withdrawing left the old
  // "Withdrawn" note stuck on screen instead of the (relevant again)
  // withdraw button.
  useEffect(() => {
    setJustWithdrawn(false);
    setJustReclaimed(false);
  }, [purchaseVersion]);

  // Real entrants from the live round (see useRoundEntrants). Who wins is
  // now decided on-chain (DrawWinner) - spinning only animates a reveal of
  // that already-known result, it never picks the winner itself.
  const maxPlayers = roundState.status === "loaded" ? roundState.config.max_players : 10;
  const arcs = useMemo(
    () => (entrants.length > 0 ? buildArcs(entrants) : buildPlaceholderArcs(maxPlayers)),
    [entrants, maxPlayers]
  );
  const { canvasRef, spinning, result, spin, reset } = useWheelSpin(arcs, drawPixelWheel);

  // Ticks every second so the countdown reads live and the close button
  // enables itself the instant the deadline passes, without the player
  // needing to do anything to trigger a re-render.
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  function spinToWinner(winnerAddress: string) {
    spin(winnerAddress, () => {
      if (walletState.status === "connected" && roundState.status === "loaded") {
        markRevealed(contractAddress ?? WHEEL_MANAGER_ADDRESS, roundState.round.round_id, walletState.address);
        onRevealed?.();
      }
    });
  }

  async function handleCloseRound() {
    if (walletState.status !== "connected") return;
    setActionBusy("closing");
    setActionError(null);
    try {
      await closeRound(walletState.wallet, contractAddress);
      roundState.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleExpireRound() {
    if (walletState.status !== "connected" || roundState.status !== "loaded") return;
    const expiredRoundId = roundState.round.round_id;
    setActionBusy("expiring");
    setActionError(null);
    try {
      await expireRound(walletState.wallet, contractAddress);
      onRoundFinished(expiredRoundId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  // 3-phase outage safety net for a Closed round that has gone unrevealed too
  // long (the keeper is down) - see lib/roundActions.ts. Request's own
  // stuckEligible countdown is precomputed client-side (closed_at +
  // max_reveal_age_seconds, both already known), but Finalize/Claim aren't -
  // the query doesn't expose expire_requested_at_height/
  // expiry_pending_since_height, or whether this round is genuinely at the
  // front of REVEAL_QUEUE - the contract's own rejection surfaces as
  // friendly text (friendlyRoundError) if a step is tried before it's ready,
  // same pattern RaffleDetailPage.tsx already uses for CYOL.
  async function handleRequestExpireClosed() {
    // Guards the merged button below against firing early: it stays visible
    // (not HTML-disabled, so it keeps its pixel-art border instead of
    // flattening to .round-action-btn:disabled) through the whole countdown,
    // only actually clickable in effect once this passes.
    if (walletState.status !== "connected" || roundState.status !== "loaded" || !stuckEligible) return;
    setActionBusy("requestingRescue");
    setActionError(null);
    try {
      await requestExpireClosedRound(walletState.wallet, roundState.round.round_id, contractAddress);
      setRequestSubmitted(true);
      setRequestSubmittedAt(Math.floor(Date.now() / 1000));
      roundState.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // A redundant Request (this session already got one through, or a
      // page refresh lost track of that) rejects with this exact text -
      // re-syncs local state instead of leaving the button stuck offering
      // "Request" forever when Finalize is what's actually next. No
      // requestSubmittedAt here deliberately - we don't know when the real
      // Request actually landed, so no Finalize countdown shows rather than
      // a wrong one (falls back to the plain "Finalize rescue" label).
      if (/expiration request .* is already pending/i.test(message)) setRequestSubmitted(true);
      setActionError(message ? friendlyRoundError(message) : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleFinalizeExpireClosed() {
    // The !stuckEligible check alone isn't enough here (found live,
    // 2026-09-18) - it never turns back false once true, so it doesn't
    // guard against Finalize's own separate delay after Request. The
    // locked-button visual already dims this from finalizeLocked, but the
    // real guard has to live here too, same as Request's.
    const finalizeLocked = secondsToFinalizeEligible !== null && secondsToFinalizeEligible > 0;
    if (walletState.status !== "connected" || roundState.status !== "loaded" || !stuckEligible || finalizeLocked) return;
    setActionBusy("finalizingRescue");
    setActionError(null);
    try {
      await finalizeExpireClosedRound(walletState.wallet, roundState.round.round_id, contractAddress);
      setFinalizeSubmittedAt(Math.floor(Date.now() / 1000));
      roundState.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // The Request itself has a TTL (REQUEST_EXPIRE_TTL_BLOCKS) - if it
      // lapses before Finalize is tried, the round needs a fresh Request,
      // not another Finalize. Without this, the merged button stays stuck
      // offering "Finalize" forever, since requestSubmitted never resets on
      // its own (CodeRabbit, PR #53).
      if (/expiration request .* has expired/i.test(message)) {
        setRequestSubmitted(false);
        setRequestSubmittedAt(null);
      }
      setActionError(message ? friendlyRoundError(message) : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  // Marks the round Expired (like handleExpireRound above, this never moves
  // funds itself) - the pre-existing Reclaim Ticket button, already shown for
  // any Expired round below, is what each entrant then uses to actually get
  // their ticket money back.
  async function handleClaimExpiredClosed() {
    // Same visible-but-locked pattern as Request/Finalize above - the real
    // guard lives here, not in the button's disabled attribute.
    const claimLocked = secondsToClaimEligible !== null && secondsToClaimEligible > 0;
    if (walletState.status !== "connected" || roundState.status !== "loaded" || claimLocked) return;
    setActionBusy("claimingRescue");
    setActionError(null);
    try {
      await claimExpiredRound(walletState.wallet, roundState.round.round_id, contractAddress);
      roundState.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? friendlyRoundError(err.message) : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleReclaimTicket() {
    if (walletState.status !== "connected" || roundState.status !== "loaded") return;
    setActionBusy("reclaiming");
    setActionError(null);
    try {
      await reclaimTicket(walletState.wallet, roundState.round.round_id, contractAddress);
      setJustReclaimed(true);
      roundState.refetch();
      onEntrantsChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleWithdrawTicket() {
    if (walletState.status !== "connected" || roundState.status !== "loaded") return;
    setActionBusy("withdrawing");
    setActionError(null);
    try {
      await withdrawTicket(walletState.wallet, roundState.round.round_id, contractAddress);
      setJustWithdrawn(true);
      roundState.refetch();
      onEntrantsChanged?.();
      onWithdrawn?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  function handleContinue() {
    reset();
    setJustReclaimed(false);
    setJustWithdrawn(false);
    onContinue();
  }

  // Prize/pool/ticket-price come from the live round query.
  const loaded = roundState.status === "loaded";
  // Same scroll-reset pattern as FAQClassroomPanel's screen body - without
  // it, scrolling down to read a long message (wheel.expiredNote) and then
  // the round moving on to a new state would leave the next message
  // scrolled to wherever the old one left off instead of starting at top.
  const messageScreenRef = useRef<HTMLDivElement>(null);
  const messageScreenKey = loaded ? `${roundState.round.round_id}-${roundState.round.status}` : "loading";
  useEffect(() => {
    if (messageScreenRef.current) messageScreenRef.current.scrollTop = 0;
  }, [messageScreenKey]);
  const prizeUluna = loaded
    ? (BigInt(roundState.round.pool) * BigInt(Math.round(PRIZE_SHARE * 100))) / 100n
    : null;
  const prizeDisplay = prizeUluna !== null ? formatUluna(prizeUluna.toString(), "USDC") : t("wheel.loading");
  const ticketPriceDisplay = loaded
    ? formatUluna(roundState.config.ticket_price, "USDC")
    : t("wheel.loading");
  const roiPercent =
    loaded && prizeUluna !== null
      ? Math.round(
          (Number(prizeUluna) / Number(roundState.config.ticket_price) - 1) * 100
        )
      : null;
  const poolDisplay = loaded ? formatUluna(roundState.round.pool, "USDC") : t("wheel.loading");
  const ticketCount = loaded ? roundState.round.ticket_count : null;

  // Chain block time can lag a few seconds behind the browser's clock (block
  // production isn't perfectly wall-clock synced), so the contract can still
  // reject CloseRound for a moment even after the client-side countdown
  // hits zero. This buffer avoids surfacing that as a confusing tx error -
  // better to make the button appear a few seconds late than fail once.
  const DEADLINE_SAFETY_BUFFER_SECONDS = 8;
  const deadline = loaded ? roundState.round.deadline : null;
  const secondsToDeadline = deadline !== null ? Math.max(0, Math.ceil(deadline - nowSec)) : null;
  const closeEligible =
    loaded &&
    (roundState.round.unique_player_count >= roundState.config.max_players ||
      (deadline !== null && nowSec >= deadline + DEADLINE_SAFETY_BUFFER_SECONDS));

  // Counterpart to closeEligible for a round that never reached min_players -
  // deadline stays null in that case (see execute_buy_ticket), so this can
  // only ever become eligible while closeEligible is false.
  const hasMinPlayers = loaded && roundState.round.unique_player_count >= roundState.config.min_players;
  const expireEligible =
    loaded &&
    !hasMinPlayers &&
    nowSec >= roundState.round.opened_at + roundState.config.max_round_age_seconds + DEADLINE_SAFETY_BUFFER_SECONDS;

  // Mirrors execute_request_expire_closed_round's own condition exactly
  // (closed_at + max_reveal_age_seconds) - the outage safety net becomes
  // relevant once a Closed round has sat unrevealed this long.
  const stuckEligible =
    loaded &&
    roundState.round.status === "closed" &&
    roundState.round.closed_at !== null &&
    nowSec >= roundState.round.closed_at + roundState.config.max_reveal_age_seconds;

  // Countdown to stuckEligible - see its render site in lab-screen-message
  // below for why this needs to be shown at all.
  const secondsToRescueEligible =
    loaded && roundState.round.status === "closed" && roundState.round.closed_at !== null
      ? Math.ceil(roundState.round.closed_at + roundState.config.max_reveal_age_seconds - nowSec)
      : null;

  // Same countdown, next phase - only known at all if Request happened this
  // session (see requestSubmittedAt's own comment on the approximation).
  const secondsToFinalizeEligible =
    requestSubmittedAt !== null ? Math.ceil(requestSubmittedAt + FINALIZE_DELAY_SECONDS - nowSec) : null;

  // Same countdown, third phase - only known if Finalize happened this
  // session (see finalizeSubmittedAt's own comment).
  const secondsToClaimEligible =
    finalizeSubmittedAt !== null ? Math.ceil(finalizeSubmittedAt + CLAIM_DELAY_SECONDS - nowSec) : null;

  // Whether the top full-width action slot is taken by Redeem. When it's
  // not (any revealed round where this wallet isn't sitting on an unclaimed
  // prize - not just "didn't win"), Continue moves up into that same slot
  // instead of sitting next to Verify - see the "Next Round"/"Continue"
  // buttons below. Keeps the scientist+Verify row in the exact same spot
  // whether there are 2 buttons or 3, instead of it shifting up whenever
  // Redeem is absent.
  const isWinnerWithPrize =
    result.kind === "won" &&
    loaded &&
    walletState.status === "connected" &&
    roundState.round.winner === walletState.address &&
    roundState.round.prize_remaining !== "0";

  // View-previous-round, Expire Round and Withdraw ticket can all be
  // simultaneously eligible (a real state: round_id>1 is independent of
  // !hasMinPlayers, and Expire/Withdraw both only need !hasMinPlayers) -
  // stacked as 3 separate full-size buttons, the column grew taller than
  // .cabinet-actions-right's own screen image, which then had to stretch to
  // match and visibly deformed (reported live on Weekly Round, which shares
  // this exact layout, then confirmed to be live on Wheel of Repeg's own
  // production site too). Computed here so the JSX below can decide, per
  // combination, when each button needs its compact treatment vs. when it
  // can keep its original full-size solo styling.
  const showViewPreviousRound = loaded && roundState.round.status === "open" && roundState.round.round_id > 1;
  const showExpireRound = loaded && roundState.round.status === "open" && !closeEligible && expireEligible;
  const showWithdrawTicket =
    loaded &&
    roundState.round.status === "open" &&
    !hasMinPlayers &&
    !justWithdrawn &&
    walletState.status === "connected" &&
    entrants.some((e) => e.address === walletState.address);

  function formatCountdown(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // First pass at the Host mechanic (revived from session 3, unused since -
  // see HostGuide.tsx): only a handful of SHORT messages go through it so
  // far - the .rectangulo bubble can genuinely resize to fit text (real
  // 9-slice border-image), but .alarma/.nube can't stretch without
  // distorting their spiky/scalloped shapes, so they're reserved for short
  // lines only. Long paragraphs (expired note, drawnByOther, etc.) stay as
  // plain text in the status card, untouched - see the "Todavía no
  // decidido" list in the project notes for what's still unmigrated.
  const HOST_HYPE_LINES = t("wheel.hostHype", { returnObjects: true }) as string[];
  const [hypeIndex, setHypeIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setHypeIndex((i) => (i + 1) % HOST_HYPE_LINES.length), 8000);
    return () => clearInterval(id);
  }, [HOST_HYPE_LINES.length]);

  const hostBubble: { type: "rectangulo" | "horizontal" | "alarma" | "nube"; message: string } | null = (() => {
    if (!loaded) return null;
    // Checked before the generic "waiting for min players" branch below -
    // both share the exact same secondsToDeadline===null condition (the
    // deadline stays null until min players is reached, withdrawn ticket
    // or not), so this has to win the tie or it's dead code.
    if (
      roundState.round.status === "open" &&
      !hasMinPlayers &&
      justWithdrawn &&
      walletState.status === "connected"
    ) {
      return { type: "horizontal", message: t("wheel.withdrawnNote") };
    }
    if (roundState.round.status === "open" && !closeEligible && !expireEligible) {
      if (secondsToDeadline !== null && secondsToDeadline <= 20) {
        return { type: "alarma", message: t("wheel.lastCallShort") };
      }
      if (secondsToDeadline !== null) {
        return {
          type: "horizontal",
          message: t("wheel.closesIn", { roundId: roundState.round.round_id, time: formatCountdown(secondsToDeadline) }),
        };
      }
      if (secondsToDeadline === null) {
        return {
          type: "horizontal",
          message: t("wheel.waitingForMinPlayers", { roundId: roundState.round.round_id, min: roundState.config.min_players }),
        };
      }
    }
    if (roundState.round.status === "closed") {
      return { type: "horizontal", message: t("wheel.closedWaitingDraw") };
    }
    if (roundState.round.status === "expiry_pending") {
      return { type: "horizontal", message: t("wheel.expiryPendingNote") };
    }
    if (roundState.round.status === "expired" && justReclaimed) {
      return { type: "horizontal", message: t("wheel.reclaimedNote") };
    }
    return { type: "nube", message: HOST_HYPE_LINES[hypeIndex] };
  })();

  // Renders as 3 separate top-level pieces (a Fragment, not one wrapping
  // div) so the parent's CSS Grid (see WheelOfRepeg's .wheel-cabinet) can
  // place each one in its own named area - header full-width up top, the
  // wheel visual in the center column, actions right under it - instead of
  // everything being trapped inside a single nested box.
  return (
    <>
      <div className="cabinet-header prize-banner">
        <img src="/wheel-pixel/prize-banner.png" alt="" className="prize-banner-bg" />
        <div className="prize-banner-content">
          {loaded && (
            <p className="prize-round-badge">{t("wheel.roundBadge", { roundId: roundState.round.round_id })}</p>
          )}
          <p className="prize-label">
            <img src="/wheel-pixel/trophy-icon.png" alt="" className="prize-label-icon" />
            {t("wheel.prizeLabel")}
          </p>
          <p className="prize-amount">{prizeDisplay}</p>
          <p className="prize-roi-caption">
            {roiPercent !== null && (
              <span className="prize-roi">
                {roiPercent >= 0 ? "+" : ""}
                {roiPercent}%
              </span>
            )}{" "}
            {t("wheel.roiCaption", { price: ticketPriceDisplay })}
          </p>
        </div>
      </div>

      <div className="cabinet-wheel-outline pixel-stepped-corners">
      <div className="cabinet-wheel-border pixel-stepped-corners">
      <div className="cabinet-wheel-highlight pixel-stepped-corners">
      <div className="wheel-booth-slot pixel-stepped-corners">
          <div className="wheel-booth-wrap">
            <img src="/wheel-pixel/cabinet-wheel-bg.png" alt="" className="wheel-booth-bg" />
            <img src="/brand/isotipo-pixel-art.png" alt="" className="wheel-booth-logo" />
            <div className="wheel-booth-wheel">
              <PixelWheelCanvas canvasRef={canvasRef} />
            </div>
            {hostBubble && (
              <div
                className={`wheel-booth-host-bubble${
                  hostBubble.type === "nube" ? " wheel-booth-host-bubble-nube" : ""
                }`}
              >
                <HostGuide message={hostBubble.message} bubbleType={hostBubble.type} />
              </div>
            )}
          </div>
      </div>
      </div>
      </div>
      </div>

      <div className="cabinet-actions-outline pixel-stepped-corners">
      <div className="cabinet-actions-border pixel-stepped-corners">
      <div className="cabinet-actions-highlight pixel-stepped-corners">
      <div className="cabinet-actions pixel-stepped-corners">
      <div className="cabinet-actions-left">
      {loaded && roundState.round.status === "open" && closeEligible && (
        <button
          className="round-action-btn"
          onClick={handleCloseRound}
          disabled={actionBusy !== "idle" || walletState.status !== "connected"}
        >
          {actionBusy === "closing" ? t("wheel.closing") : t("wheel.closeRound")}
        </button>
      )}

      {/* View Previous Round always gets its own row (never shares one with
          Expire/Withdraw below) - full solo treatment (icon, 2-line text,
          bigger font, auto-margin vertical centering - see
          .cabinet-actions .round-action-btn-view-previous in wheel.css) only
          when it's truly the sole thing in this column; the moment Expire
          and/or Withdraw will ALSO render below it, it switches to the same
          compact single-line sizing as .wheel-actions-row-btn so it doesn't
          add to the height problem those 2 solve below. Close Round isn't
          part of this check - Close+View-Previous is a pre-existing
          combination this session didn't touch or get asked about. */}
      {showViewPreviousRound && !showExpireRound && !showWithdrawTicket && (
        <button
          type="button"
          className="round-action-btn round-action-btn-compact round-action-btn-view-previous"
          onClick={() => onViewRound?.(roundState.round.round_id - 1)}
        >
          <img src="/wheel-pixel/wheel-emoji.png" alt="" className="round-action-btn-icon" />
          {t("wheel.viewPreviousRoundLine1", { roundId: roundState.round.round_id - 1 })}
          <br />
          {t("wheel.viewPreviousRoundLine2")}
        </button>
      )}
      {showViewPreviousRound && (showExpireRound || showWithdrawTicket) && (
        <button
          type="button"
          className="round-action-btn round-action-btn-compact round-action-btn-view-previous wheel-actions-compact-btn"
          onClick={() => onViewRound?.(roundState.round.round_id - 1)}
        >
          <img src="/wheel-pixel/wheel-emoji.png" alt="" className="round-action-btn-icon" />
          {t("wheel.viewPreviousRoundLine1", { roundId: roundState.round.round_id - 1 })}
        </button>
      )}

      {/* Expire Round + Withdraw ticket - same combined-row treatment as
          Weekly Round's own final version of this exact button cluster
          (Withdraw + Expire share a row, View Previous stays separate
          above it), not the View-Previous+Withdraw pairing this session
          first tried here - that left Expire Round still at full size in
          its own row above/below this one, which could reproduce the same
          height/stretch problem this whole fix exists for whenever Expire,
          View Previous AND Withdraw are all eligible at once (a real state:
          Expire and Withdraw both only need !hasMinPlayers). Renders even
          with just one of the two present, same as Weekly Round, for one
          consistent compact treatment instead of a 3rd separate full-size
          variant. */}
      {(showExpireRound || showWithdrawTicket) && (
        <div className="wheel-actions-row">
          {showWithdrawTicket && (
            <button
              className="round-action-btn round-action-btn-secondary wheel-actions-row-btn"
              onClick={handleWithdrawTicket}
              disabled={actionBusy !== "idle"}
            >
              {actionBusy === "withdrawing" ? t("wheel.withdrawing") : t("wheel.withdrawTicket")}
            </button>
          )}
          {showExpireRound && (
            <button
              className="round-action-btn wheel-actions-row-btn"
              onClick={handleExpireRound}
              disabled={actionBusy !== "idle" || walletState.status !== "connected"}
            >
              {actionBusy === "expiring" ? t("wheel.expiring") : t("wheel.expireRound")}
            </button>
          )}
        </div>
      )}

      {/* Outage safety net - one button covering both Request and Finalize
          (merged 2026-09-18, per direct request - having both sit side by
          side from the moment a round closes read as confusing rather than
          reassuring). Visible, with its full pixel-art border, as soon as a
          round is Closed at all - not HTML-disabled while locked (that
          would trigger .round-action-btn:disabled's box-shadow:none and
          flatten it, looking broken rather than "armed and counting down");
          instead .round-action-btn-locked only dims it, and the real guard
          against firing early lives inside handleRequestExpireClosed/
          handleFinalizeExpireClosed themselves. requestSubmitted (best-
          effort local tracking, see its own comment) decides which of the
          two this actually calls and which label it shows once unlocked -
          Finalize never appears before Request has actually gone through. */}
      {loaded &&
        roundState.round.status === "closed" &&
        walletState.status === "connected" &&
        (() => {
          // Only known if Request happened this session - see
          // requestSubmittedAt's own comment. null means "don't know", not
          // "not locked", so a stale/refreshed session falls back to plain
          // "Finalize rescue" instead of a countdown it can't back up.
          const finalizeLocked = requestSubmitted && secondsToFinalizeEligible !== null && secondsToFinalizeEligible > 0;
          const locked = !stuckEligible || finalizeLocked;
          return (
            <button
              className={`round-action-btn round-action-btn-secondary${locked ? " round-action-btn-locked" : ""}`}
              onClick={requestSubmitted ? handleFinalizeExpireClosed : handleRequestExpireClosed}
              disabled={actionBusy !== "idle"}
            >
              {actionBusy === "requestingRescue" || actionBusy === "finalizingRescue"
                ? t("wheel.rescuing")
                : !stuckEligible
                  ? t("wheel.rescueRequestLocked", { time: formatCountdown(secondsToRescueEligible ?? 0) })
                  : finalizeLocked
                    ? t("wheel.rescueRequestLocked", { time: formatCountdown(secondsToFinalizeEligible ?? 0) })
                    : requestSubmitted
                      ? t("wheel.rescueFinalize")
                      : t("wheel.rescueRequest")}
            </button>
          );
        })()}
      {loaded &&
        roundState.round.status === "expiry_pending" &&
        walletState.status === "connected" &&
        (() => {
          const claimLocked = secondsToClaimEligible !== null && secondsToClaimEligible > 0;
          return (
            <button
              className={`round-action-btn${claimLocked ? " round-action-btn-locked" : ""}`}
              onClick={handleClaimExpiredClosed}
              disabled={actionBusy !== "idle"}
            >
              {actionBusy === "claimingRescue"
                ? t("wheel.rescuing")
                : claimLocked
                  ? t("wheel.rescueRequestLocked", { time: formatCountdown(secondsToClaimEligible ?? 0) })
                  : t("wheel.rescueClaim")}
            </button>
          );
        })()}

      {loaded && roundState.round.status === "expired" && (
        <>
          {!justReclaimed &&
            walletState.status === "connected" &&
            entrants.some((e) => e.address === walletState.address) && (
              <button
                className="round-action-btn"
                onClick={handleReclaimTicket}
                disabled={actionBusy !== "idle"}
              >
                {actionBusy === "reclaiming" ? t("wheel.reclaiming") : t("wheel.reclaimTicket")}
              </button>
            )}
          <button className="round-action-btn" onClick={handleContinue}>
            {t("wheel.continueNextRound")}
          </button>
        </>
      )}

      {loaded && roundState.round.status === "drawn" && result.kind !== "won" && (
        <button
          className="spin-btn"
          onClick={() => roundState.round.winner && spinToWinner(roundState.round.winner)}
          disabled={spinning || !roundState.round.winner}
        >
          {t("wheel.spin")}
        </button>
      )}

      {isWinnerWithPrize && (
        <button className="round-action-btn redeem-open-btn" onClick={() => setIsRedeemOpen(true)}>
          {t("wheel.redeem")}
        </button>
      )}

      {result.kind === "won" && !isWinnerWithPrize && (
        <button className="round-action-btn continue-top-btn" onClick={handleContinue}>
          {t("wheel.continueNextRound")}
        </button>
      )}

      {isRedeemOpen &&
        loaded &&
        createPortal(
          <div className="verify-modal-backdrop" onClick={() => setIsRedeemOpen(false)}>
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
                      onClick={() => setIsRedeemOpen(false)}
                      aria-label={t("verify.close")}
                    >
                      &times;
                    </button>
                    <RedeemBox
                      roundId={roundState.round.round_id}
                      redemptionDenom={roundState.config.redemption_denom}
                      prizeRemainingUluna={roundState.round.prize_remaining}
                      unclaimedDeadlineDays={roundState.config.unclaimed_deadline_days}
                      contractAddress={contractAddress}
                      onRedeemed={() => {
                        roundState.refetch();
                        onRedeemed?.();
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {loaded && roundState.round.status === "drawn" && (
        <div className={`verify-continue-row${isWinnerWithPrize || isViewingHistory ? "" : " verify-continue-row-solo"}`}>
          <VerifyRoundPanel roundId={roundState.round.round_id} contractAddress={contractAddress} />
          {isWinnerWithPrize && (
            <button className="verify-open-btn continue-next-btn" onClick={handleContinue}>
              {t("wheel.continueShort").split("\n").map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </button>
          )}
          {!isWinnerWithPrize && isViewingHistory && (
            <button className="verify-open-btn continue-next-btn" onClick={handleContinue}>
              {t("wheel.backToCurrent").split("\n").map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </button>
          )}
        </div>
      )}
      </div>

      <div className="cabinet-actions-right">
      <div className="lab-screen">
      <img src="/characters/lab-screen.png" alt="" />
      <div className="lab-screen-messages">
      <p className="lab-screen-title">{t("wheel.screenTitle")}</p>

      <div className="lab-screen-message" ref={messageScreenRef}>
      {/* Neither branch has card text here anymore - the Host already
          covers both (alarma for the urgent countdown, horizontal for the
          normal one), same pattern as the other skipped notes above. */}

      {/* justWithdrawn's note is skipped here - the Host already says it
          (see hostBubble above), same pattern as waitingForMinPlayers and
          drawnByYou. */}
      {loaded &&
        roundState.round.status === "open" &&
        !hasMinPlayers &&
        !justWithdrawn &&
        walletState.status === "connected" &&
        entrants.some((e) => e.address === walletState.address) && (
          <p className="withdraw-lockin-note">{t("wheel.withdrawLockInNote")}</p>
        )}

      {/* closedWaitingDraw itself is skipped here - the Host already says it
          (see hostBubble above). This countdown isn't, though: it only ever
          shows once the round has sat Closed long enough to matter, and a
          silent screen at that point reads as the site having swallowed the
          player's ticket, not as a safety net quietly ticking down (found
          live, 2026-09-18, watching a real Closed round with the keeper
          deliberately down for a drill). */}
      {/* !requestSubmitted matters here (found live, 2026-09-18): once
          Request has actually gone through, this phase-1 message going
          stale and still claiming "available now" reads as the WHOLE
          refund being ready, when only Request was - the Finalize message
          below takes over exclusively from here instead of stacking with
          this leftover one. */}
      {!requestSubmitted && secondsToRescueEligible !== null && (
        <p className="round-status-note">
          {secondsToRescueEligible > 0
            ? t("wheel.rescueCountdownLabel", { time: formatCountdown(secondsToRescueEligible) })
            : t("wheel.rescueAvailableLabel")}
        </p>
      )}
      {/* Same reasoning, next phase. requestSubmitted can be true with no
          timestamp to back it up (a redundant Request this session, after
          the real one already landed earlier - see requestSubmittedAt's own
          comment) - falls back to a plain no-countdown note instead of
          going silent again, the exact regression this whole thing exists
          to avoid. status === "closed" matters too (CodeRabbit, PR #53):
          requestSubmitted otherwise stays true straight through
          ExpiryPending/Expired, stacking this stale note on top of the
          Claim/expired messages below instead of yielding to them. */}
      {requestSubmitted && loaded && roundState.round.status === "closed" && (
        <p className="round-status-note">
          {secondsToFinalizeEligible === null
            ? t("wheel.rescueFinalizeUnknownLabel")
            : secondsToFinalizeEligible > 0
              ? t("wheel.rescueFinalizeCountdownLabel", { time: formatCountdown(secondsToFinalizeEligible) })
              : t("wheel.rescueFinalizeAvailableLabel")}
        </p>
      )}
      {/* Same reasoning, third phase - status itself (not a local flag) is
          reliable here, since ExpiryPending can only ever be reached via a
          successful Finalize. */}
      {loaded && roundState.round.status === "expiry_pending" && (
        <p className="round-status-note">
          {secondsToClaimEligible === null
            ? t("wheel.rescueClaimUnknownLabel")
            : secondsToClaimEligible > 0
              ? t("wheel.rescueClaimCountdownLabel", { time: formatCountdown(secondsToClaimEligible) })
              : t("wheel.rescueClaimAvailableLabel")}
        </p>
      )}

      {/* reclaimedNote is skipped here too, same pattern - the Host already
          says it (see hostBubble above). expiredNote stays, it's long.
          RoundStatus::Expired is reached 2 different ways (see the
          contract's own doc comment on that variant) - never reached
          min_players, or reached Closed and then rescued via the 3-phase
          outage safety net after going unrevealed too long. Deliberately
          NOT hasMinPlayers here (found live, 2026-09-18): that reads
          unique_player_count, which ReclaimTicket decrements as each
          entrant claims their refund - once every entrant has reclaimed, a
          genuinely-rescued round reads back as 0 players and wrongly looks
          like it never reached the minimum at all. closed_at is never
          touched by ReclaimTicket, and is only ever set by the
          reached-minimum path (execute_close_round) - the never-reached
          path (ExpireRound) goes straight from Open to Expired without
          ever setting it, so it survives every reclaim intact. */}
      {loaded && roundState.round.status === "expired" && (
        <p className="round-status-note">
          {roundState.round.closed_at !== null ? t("wheel.expiredNoteRescued") : t("wheel.expiredNote")}
        </p>
      )}

      {loaded && roundState.round.status === "drawn" && result.kind !== "won" && (
        <p className="round-status-note">{t("wheel.drawnByOther")}</p>
      )}

      {actionError && <p className="round-action-error">{actionError}</p>}

      {result.kind === "spinning" && <p className="result">{t("wheel.spinning")}</p>}
      {result.kind === "won" && (
        <>
          <p className="result">
            {t("wheel.winPrefix")} <strong>{result.winner}</strong>
          </p>
          <p className="result">{t("wheel.continuePrompt")}</p>
        </>
      )}
      </div>

      <div className="lab-screen-stats">
        {loaded ? (
          <>
            {/* Same addition as Weekly Round's own lab-screen-stats, for
                parity - the prize banner up top already carries this (see
                .prize-round-badge above) but reads as decorative there and
                is easy to miss; repeating it next to the other per-round
                numbers a player actually checks is where they expect it. */}
            <p>{t("wheel.roundBadge", { roundId: roundState.round.round_id })}</p>
            <p>{t("wheel.ticketsSoldLabel", { count: ticketCount })}</p>
            <p>{t("wheel.poolPrizeLabel", { amount: poolDisplay })}</p>
          </>
        ) : (
          <p>{t("wheel.loading")}</p>
        )}
      </div>
      </div>
      </div>
      </div>
      </div>
      </div>
      </div>
      </div>
    </>
  );
}
