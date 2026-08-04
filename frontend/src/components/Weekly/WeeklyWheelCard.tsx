import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { buildArcs, buildPlaceholderArcs, type Entrant } from "../../lib/wheelData";
import { useWheelSpin } from "../../hooks/useWheelSpin";
import { PixelWheelCanvas } from "../Wheel/PixelWheelCanvas";
import { drawWeeklyPixelWheel } from "../../lib/drawWeeklyPixelWheel";
import { HostGuide } from "../Wheel/HostGuide";
import type { WeeklyRoundState } from "../../hooks/useWeeklyRound";
import { WEEKLY_PRIZE_SHARE } from "../../lib/queryWeeklyRound";
import { formatUluna } from "../../lib/format";
import { useWallet } from "../../contexts/WalletContext";
import {
  closeWeek,
  drawWeeklyWinner,
  expireWeek,
  reclaimWeeklyTicket,
  withdrawWeeklyTicket,
} from "../../lib/roundActions";
import { markRevealed } from "../../lib/revealCache";
import { WEEKLY_ROUND_ADDRESS } from "../../lib/deployment";
import { WeeklyVerifyRoundPanel } from "./WeeklyVerifyRoundPanel";
import { RedeemBox } from "../Wheel/RedeemBox";
import { redeemWeekly } from "../../lib/roundActions";

type WeeklyWheelCardProps = {
  weekState: WeeklyRoundState & { refetch: () => void };
  entrants: Entrant[];
  contractAddress?: string;
  purchaseVersion?: number;
  onWeekFinished: (weekId: number) => void;
  onContinue: () => void;
  onEntrantsChanged?: () => void;
  onRedeemed?: () => void;
  onWithdrawn?: () => void;
  onRevealed?: () => void;
  onViewWeek?: (weekId: number) => void;
};

// Weekly Round's own version of WheelCard - same round-lifecycle UI pattern
// (open -> closed -> drawn, spin/reveal/redeem/verify), adapted for a
// platform-wide jackpot instead of a per-tier wheel: week_id instead of
// round_id, an 85% prize share instead of 60%, and seconds_remaining read
// straight from the contract instead of a rolling deadline timestamp (Weekly
// Round uses one fixed round_duration_days window, no rolling extension).
export function WeeklyWheelCard({
  weekState,
  entrants,
  contractAddress,
  purchaseVersion,
  onWeekFinished,
  onContinue,
  onEntrantsChanged,
  onRedeemed,
  onWithdrawn,
  onRevealed,
  onViewWeek,
}: WeeklyWheelCardProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();

  const [actionBusy, setActionBusy] = useState<
    "idle" | "closing" | "drawing" | "expiring" | "reclaiming" | "withdrawing"
  >("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [justReclaimed, setJustReclaimed] = useState(false);
  const [justWithdrawn, setJustWithdrawn] = useState(false);
  const [triggeredDraw, setTriggeredDraw] = useState(false);
  // Same reasoning as Wheel of Repeg's WheelCard: Redeem opens as a popup
  // instead of inline, so it can't grow this card vertically and distort
  // the wheel-status lab-screen sitting next to the action buttons.
  const [isRedeemOpen, setIsRedeemOpen] = useState(false);

  useEffect(() => {
    if (!isRedeemOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsRedeemOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isRedeemOpen]);

  // Also resets on wallet address change, not just purchaseVersion - without
  // this, switching wallets in Keplr mid-session while staying on the same
  // week (no remount, since WeeklyWheelCard is keyed on week_id only) could
  // leave a previous wallet's justWithdrawn/justReclaimed stuck true, hiding
  // the Withdraw/Reclaim button from a genuinely eligible new wallet
  // (CodeRabbit finding, confirmed - same pre-existing gap exists in
  // WheelCard.tsx too, left as-is there since it's outside this PR's scope).
  const connectedAddress = walletState.status === "connected" ? walletState.address : null;
  useEffect(() => {
    setJustWithdrawn(false);
    setJustReclaimed(false);
  }, [purchaseVersion, connectedAddress]);

  const maxPlayers = weekState.status === "loaded" ? weekState.config.max_players : 10;
  const arcs = useMemo(
    () => (entrants.length > 0 ? buildArcs(entrants) : buildPlaceholderArcs(maxPlayers)),
    [entrants, maxPlayers]
  );
  const { canvasRef, spinning, result, spin, reset } = useWheelSpin(arcs, drawWeeklyPixelWheel);

  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  // seconds_remaining is a snapshot as of the last query, not a live value -
  // anchor it to an absolute estimate once per fetch, then tick nowSec
  // against that, same live-countdown feel as Wheel of Repeg's real
  // (server-absolute) deadline timestamp.
  const deadlineEstimate = useMemo(() => {
    if (weekState.status !== "loaded") return null;
    return Math.floor(Date.now() / 1000) + weekState.week.seconds_remaining;
  }, [weekState.status === "loaded" ? weekState.week.week_id : null, weekState.status === "loaded" ? weekState.week.seconds_remaining : null]); // eslint-disable-line react-hooks/exhaustive-deps

  function spinToWinner(winnerAddress: string) {
    spin(winnerAddress, () => {
      if (walletState.status === "connected" && weekState.status === "loaded") {
        markRevealed(contractAddress ?? WEEKLY_ROUND_ADDRESS, weekState.week.week_id, walletState.address);
        onRevealed?.();
      }
    });
  }

  async function handleCloseWeek() {
    if (walletState.status !== "connected") return;
    setActionBusy("closing");
    setActionError(null);
    try {
      await closeWeek(walletState.wallet, contractAddress);
      weekState.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleDrawWinner() {
    if (walletState.status !== "connected" || weekState.status !== "loaded") return;
    const drawnWeekId = weekState.week.week_id;
    setActionBusy("drawing");
    setActionError(null);
    try {
      await drawWeeklyWinner(walletState.wallet, contractAddress);
      setTriggeredDraw(true);
      onWeekFinished(drawnWeekId);
    } catch (err) {
      setActionError(
        err instanceof Error && err.message.includes("cannot be drawn yet")
          ? t("wheel.drawTooEarly")
          : err instanceof Error
            ? err.message
            : t("wheel.actionFailed")
      );
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleExpireWeek() {
    if (walletState.status !== "connected" || weekState.status !== "loaded") return;
    const expiredWeekId = weekState.week.week_id;
    setActionBusy("expiring");
    setActionError(null);
    try {
      await expireWeek(walletState.wallet, contractAddress);
      onWeekFinished(expiredWeekId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleReclaimTicket() {
    if (walletState.status !== "connected" || weekState.status !== "loaded") return;
    setActionBusy("reclaiming");
    setActionError(null);
    try {
      await reclaimWeeklyTicket(walletState.wallet, weekState.week.week_id, contractAddress);
      setJustReclaimed(true);
      weekState.refetch();
      onEntrantsChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("wheel.actionFailed"));
    } finally {
      setActionBusy("idle");
    }
  }

  async function handleWithdrawTicket() {
    if (walletState.status !== "connected" || weekState.status !== "loaded") return;
    setActionBusy("withdrawing");
    setActionError(null);
    try {
      await withdrawWeeklyTicket(walletState.wallet, weekState.week.week_id, contractAddress);
      setJustWithdrawn(true);
      weekState.refetch();
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
    setTriggeredDraw(false);
    onContinue();
  }

  const loaded = weekState.status === "loaded";
  const prizeUluna = loaded
    ? (BigInt(weekState.week.pool) * BigInt(Math.round(WEEKLY_PRIZE_SHARE * 100))) / 100n
    : null;
  const prizeDisplay = prizeUluna !== null ? formatUluna(prizeUluna.toString(), "USDC") : t("wheel.loading");
  const todayPriceDisplay = loaded ? formatUluna(weekState.week.today_price, "USDC") : t("wheel.loading");
  const poolDisplay = loaded ? formatUluna(weekState.week.pool, "USDC") : t("wheel.loading");
  const ticketCount = loaded ? weekState.week.ticket_count : null;

  // Chain block time can lag a few seconds behind the browser's clock, same
  // reasoning as Wheel of Repeg's WheelCard - a few seconds of the button
  // appearing late beats a confusing tx rejection.
  const DEADLINE_SAFETY_BUFFER_SECONDS = 8;
  // Display-only, clamped so the countdown never reads negative - NOT used
  // for eligibility below (that compares nowSec against the raw estimate
  // directly, same pattern as WheelCard's deadline check).
  const secondsToDeadline =
    deadlineEstimate !== null ? Math.max(0, Math.ceil(deadlineEstimate - nowSec)) : null;
  // Weekly Round has one single duration window (round_duration_days),
  // unlike Wheel Manager's separate rolling-deadline vs. hard-cap - so the
  // same deadlineEstimate serves both closeEligible (enough players) and
  // expireEligible (not enough players) below.
  const hasMinPlayers = loaded && weekState.week.unique_player_count >= weekState.config.min_players;
  const closeEligible =
    loaded &&
    (weekState.week.unique_player_count >= weekState.config.max_players ||
      (hasMinPlayers && deadlineEstimate !== null && nowSec >= deadlineEstimate + DEADLINE_SAFETY_BUFFER_SECONDS));

  const expireEligible =
    loaded &&
    !hasMinPlayers &&
    deadlineEstimate !== null &&
    nowSec >= deadlineEstimate + DEADLINE_SAFETY_BUFFER_SECONDS;

  // Same showExpireRound/showWithdrawTicket pattern as WheelCard.tsx -
  // computed once so .weekly-actions-row only renders when it will actually
  // have a button inside it (CodeRabbit finding, confirmed live: without
  // this guard the row rendered empty whenever the week was open but
  // neither condition held, and .weekly-actions-left's flex gap still
  // applied around that empty item, adding stray vertical spacing).
  const showExpireWeek =
    loaded &&
    weekState.week.status === "open" &&
    !closeEligible &&
    expireEligible &&
    walletState.status === "connected";
  const showWithdrawTicket =
    loaded &&
    weekState.week.status === "open" &&
    !hasMinPlayers &&
    !justWithdrawn &&
    walletState.status === "connected" &&
    entrants.some((e) => e.address === walletState.address);

  function formatCountdown(totalSeconds: number): string {
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Whether the top full-width action slot is taken by Redeem - same
  // reasoning as Wheel of Repeg's WheelCard (see isWinnerWithPrize there).
  const isWinnerWithPrize =
    result.kind === "won" &&
    loaded &&
    walletState.status === "connected" &&
    weekState.week.winner === walletState.address &&
    weekState.week.prize_remaining !== "0";

  // Same Host mechanic as Wheel of Repeg's WheelCard, ported as-is: short
  // status lines move into the host's speech bubble over the wheel instead
  // of sitting as plain card text (see the now-thin cabinet-actions-right
  // lab-screen below, which only keeps the long-form notes and the
  // always-visible .result line). Reuses wheel.* translation keys directly
  // where the English text doesn't mention "round" at all (withdrawnNote,
  // lastCallShort, reclaimedNote, drawnByYou, hostHype) - only
  // closedWaitingDraw needed its own weekly.* copy.
  const HOST_HYPE_LINES = t("wheel.hostHype", { returnObjects: true }) as string[];
  const [hypeIndex, setHypeIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setHypeIndex((i) => (i + 1) % HOST_HYPE_LINES.length), 8000);
    return () => clearInterval(id);
  }, [HOST_HYPE_LINES.length]);

  const hostBubble: { type: "rectangulo" | "horizontal" | "alarma" | "nube"; message: string } | null = (() => {
    if (!loaded) return null;
    if (
      weekState.week.status === "open" &&
      !hasMinPlayers &&
      justWithdrawn &&
      walletState.status === "connected"
    ) {
      return { type: "horizontal", message: t("wheel.withdrawnNote") };
    }
    if (weekState.week.status === "open" && !closeEligible && !expireEligible) {
      // Unlike Wheel of Repeg's round.deadline (which genuinely stays null
      // until min_players is reached), Weekly's deadlineEstimate is always a
      // number once loaded - seconds_remaining ticks from week open. So the
      // "waiting for minimum players" state has to be gated on hasMinPlayers
      // directly, not on secondsToDeadline === null (that branch never fires
      // here - CodeRabbit finding, confirmed live: a week below min_players
      // was showing a countdown instead of the waiting message).
      if (!hasMinPlayers) {
        return { type: "horizontal", message: t("wheel.waitingForMinPlayers", { min: weekState.config.min_players }) };
      }
      if (secondsToDeadline !== null && secondsToDeadline <= 20) {
        return { type: "alarma", message: t("wheel.lastCallShort") };
      }
      if (secondsToDeadline !== null) {
        return { type: "horizontal", message: t("weekly.closesIn", { time: formatCountdown(secondsToDeadline) }) };
      }
    }
    if (weekState.week.status === "closed") {
      return { type: "horizontal", message: t("weekly.closedWaitingDraw") };
    }
    if (weekState.week.status === "expired" && justReclaimed) {
      return { type: "horizontal", message: t("wheel.reclaimedNote") };
    }
    if (weekState.week.status === "drawn" && result.kind !== "won" && triggeredDraw) {
      return { type: "rectangulo", message: t("wheel.drawnByYou") };
    }
    return { type: "nube", message: HOST_HYPE_LINES[hypeIndex] };
  })();

  return (
    // A Fragment now, not the old single .weekly-wheel-column wrapper -
    // .weekly-cabinet (weekly.css) is a named-areas grid mirroring Wheel of
    // Repeg's own .wheel-cabinet exactly, so each of these 3 pieces needs to
    // be its own direct grid item with its own grid-area (weekly-cabinet-
    // header/-wheel/-actions below) instead of being bundled into one box -
    // that's what actually lets the narrow-mode area order put the ticket
    // booth between the header and the wheel (reported live: the booth was
    // landing below the status card instead), the same reordering Wheel of
    // Repeg's .wheel-cabinet already solved for its own booth/wheel/actions
    // trio.
    <>
      {/* Same prize-banner markup/assets as Wheel of Repeg's cabinet-header
          (see WheelCard.tsx) - .prize-banner is self-contained (its own
          container-type, no dependency on .wheel-cabinet's grid), so it
          drops in here as a sibling card instead of living inside
          .weekly-wheel-card like the old plain-text .prize-tag did. */}
      <div className="weekly-cabinet-header prize-banner">
        <img src="/wheel-pixel/prize-banner.png" alt="" className="prize-banner-bg" />
        <div className="prize-banner-content">
          {loaded && (
            <p className="prize-round-badge">{t("weekly.weekBadge", { weekId: weekState.week.week_id })}</p>
          )}
          <p className="prize-label">
            <img src="/wheel-pixel/trophy-icon.png" alt="" className="prize-label-icon" />
            {t("weekly.prizeLabel")}
          </p>
          <p className="prize-amount">{prizeDisplay}</p>
          <p className="prize-roi-caption">{t("weekly.todayPriceCaption", { price: todayPriceDisplay })}</p>
        </div>
      </div>

      {/* The wheel visual itself, now just the booth scene (booth-bg.png,
          your composed background+host image) with the functional wheel and
          the Host's speech bubble overlaid via % - same
          .wheel-booth-slot/.wheel-booth-wrap/.wheel-booth-bg pattern as
          Wheel of Repeg's WheelCard (all reused as-is from wheel.css), only
          the wheel/bubble position classes are Weekly's own
          (.weekly-booth-wheel/.weekly-booth-host-bubble - see weekly.css for
          how those % were measured against this image). No more buttons or
          status text inside this card - see the new cabinet-actions card
          below, same split Wheel of Repeg already uses.
          Framed with .weekly-wheel-outline/-border/-highlight (gold/burgundy/
          gold, Weekly's own palette) instead of .wheel-card - Wheel of
          Repeg's own cabinet wheel drops .wheel-card entirely for this exact
          slot too, same reasoning: .wheel-card's rounded border + padding
          fought a full-bleed image, and a plain 3-layer pixel frame is what
          actually fixes it (see weekly.css for the color choices and the
          removed bleed-margin hack this replaces). */}
      <div className="weekly-cabinet-wheel weekly-wheel-outline pixel-stepped-corners">
      <div className="weekly-wheel-border pixel-stepped-corners">
      <div className="weekly-wheel-highlight pixel-stepped-corners">
      <div className="wheel-booth-slot pixel-stepped-corners">
        <div className="wheel-booth-wrap">
          <img src="/weekly-pixel/booth-bg.png" alt="" className="wheel-booth-bg" />
          <img src="/brand/isotipo-pixel-art.png" alt="" className="wheel-booth-logo" />
          <div className="weekly-booth-wheel">
            <PixelWheelCanvas
              canvasRef={canvasRef}
              frameSrc="/weekly-pixel/frame.png"
              frameClassName="weekly-pixel-wheel-frame"
            />
          </div>
          {hostBubble && (
            <div
              className={`weekly-booth-host-bubble${
                hostBubble.type === "nube" ? " weekly-booth-host-bubble-nube" : ""
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

      {/* New actions card, split left/right like Wheel of Repeg's
          .cabinet-actions - button column on the left (with the scientist +
          his speech bubble, already built into WeeklyVerifyRoundPanel's own
          .verify-scientist-wrap), the wheel-status lab-screen on the right.
          Reuses the .cabinet-actions-* classes directly from wheel.css -
          grid-area:actions on .cabinet-actions-outline is a no-op here since
          this card isn't inside Wheel of Repeg's .wheel-cabinet grid, it
          just renders as a normal flex card in Weekly's own .stage layout.
          The extra weekly-actions-* classes only override the frame's 3
          background colors (gold/burgundy/gold, same as the wheel visual
          card above) - padding/layout/grid-area still come from the shared
          .cabinet-actions-* classes, untouched. */}
      <div className="weekly-cabinet-actions cabinet-actions-outline weekly-actions-outline pixel-stepped-corners">
      <div className="cabinet-actions-border weekly-actions-border pixel-stepped-corners">
      <div className="cabinet-actions-highlight weekly-actions-highlight pixel-stepped-corners">
      <div className="cabinet-actions weekly-actions pixel-stepped-corners">
      <div className="cabinet-actions-left weekly-actions-left">
      {/* Wallet-connected is part of the render condition now, not just
          `disabled` - a disconnected wallet used to still render this
          (dimmed via .round-action-btn:disabled's opacity:0.5), which read
          as "flickers transparent then solid" once the wallet connects
          (reported live). Disappearing outright while disconnected and
          appearing solid once connected - the only remaining disabled
          state is the brief actionBusy!=="idle" window during the tx
          itself, same as everywhere else in the app. */}
      {loaded && weekState.week.status === "open" && closeEligible && walletState.status === "connected" && (
        <button
          className="round-action-btn"
          onClick={handleCloseWeek}
          disabled={actionBusy !== "idle"}
        >
          {actionBusy === "closing" ? t("wheel.closing") : t("weekly.closeWeek")}
        </button>
      )}

      {/* Same top-full-width + bottom-2-square-buttons layout as the
          Redeem/Verify/Next trio elsewhere in this column, repurposed for
          a different real combo: Check-previous-week takes the long top
          slot (Redeem's spot), Withdraw ticket and Expire Round share the
          bottom row (Verify/Next's spots) - Expire Round's own font
          shrunk to fit that narrower slot, per direct request. Expire and
          Withdraw are a real simultaneous state (both only need
          !hasMinPlayers-ish conditions); Close Round stays a separate top
          button above this block since it requires hasMinPlayers, which
          makes it mutually exclusive with Withdraw - never needs to share
          a row with it. */}
      {loaded && weekState.week.status === "open" && weekState.week.week_id > 1 && (
        <button
          type="button"
          className="round-action-btn round-action-btn-compact"
          onClick={() => onViewWeek?.(weekState.week.week_id - 1)}
        >
          {t("weekly.viewPreviousWeek", { weekId: weekState.week.week_id - 1 })}
        </button>
      )}
      {(showWithdrawTicket || showExpireWeek) && (
        <div className="weekly-actions-row">
          {showWithdrawTicket && (
            <button
              className="round-action-btn round-action-btn-secondary weekly-actions-row-btn"
              onClick={handleWithdrawTicket}
              disabled={actionBusy !== "idle"}
            >
              {actionBusy === "withdrawing" ? t("wheel.withdrawing") : t("weekly.withdrawTicket")}
            </button>
          )}
          {showExpireWeek && (
            <button
              className="round-action-btn weekly-actions-row-btn weekly-expire-btn"
              onClick={handleExpireWeek}
              disabled={actionBusy !== "idle"}
            >
              {actionBusy === "expiring" ? t("wheel.expiring") : t("wheel.expireRound")}
            </button>
          )}
        </div>
      )}

      {loaded && weekState.week.status === "closed" && (
        <button
          className="round-action-btn"
          onClick={handleDrawWinner}
          disabled={actionBusy !== "idle" || walletState.status !== "connected"}
        >
          {actionBusy === "drawing" ? t("wheel.drawing") : t("wheel.drawWinner")}
        </button>
      )}

      {loaded && weekState.week.status === "expired" && (
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
            {t("weekly.continueNextWeek")}
          </button>
        </>
      )}

      {loaded && weekState.week.status === "drawn" && result.kind !== "won" && (
        <button
          className="spin-btn"
          onClick={() => weekState.week.winner && spinToWinner(weekState.week.winner)}
          disabled={spinning || !weekState.week.winner}
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
          {t("weekly.continueNextWeek")}
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
                      roundId={weekState.week.week_id}
                      redemptionDenom={weekState.config.redemption_denom}
                      prizeRemainingUluna={weekState.week.prize_remaining}
                      unclaimedDeadlineDays={weekState.config.unclaimed_deadline_days}
                      contractAddress={contractAddress}
                      redeemAction={redeemWeekly}
                      onRedeemed={() => {
                        weekState.refetch();
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

      {loaded && weekState.week.status === "drawn" && (
        <div className={`verify-continue-row${isWinnerWithPrize ? "" : " verify-continue-row-solo"}`}>
          <WeeklyVerifyRoundPanel weekId={weekState.week.week_id} contractAddress={contractAddress} />
          {isWinnerWithPrize && (
            <button className="verify-open-btn continue-next-btn" onClick={handleContinue}>
              {t("weekly.continueShort").split("\n").map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </button>
          )}
        </div>
      )}
      </div>

      <div className="cabinet-actions-right weekly-actions-right">
      <div className="lab-screen">
      <img src="/weekly-pixel/lab-screen.png" alt="" />
      <div className="lab-screen-messages">
      <p className="lab-screen-title">{t("wheel.screenTitle")}</p>

      <div className="lab-screen-message">
      {loaded &&
        weekState.week.status === "open" &&
        !hasMinPlayers &&
        !justWithdrawn &&
        walletState.status === "connected" &&
        entrants.some((e) => e.address === walletState.address) && (
          <p className="withdraw-lockin-note">{t("wheel.withdrawLockInNote")}</p>
        )}

      {loaded && weekState.week.status === "expired" && (
        <p className="round-status-note">{t("wheel.expiredNote")}</p>
      )}

      {loaded && weekState.week.status === "drawn" && result.kind !== "won" && !triggeredDraw && (
        <p className="round-status-note">{t("wheel.drawnByOther")}</p>
      )}

      {actionError && <p className="round-action-error">{actionError}</p>}

      {result.kind === "spinning" && <p className="result">{t("wheel.spinning")}</p>}
      {result.kind === "idle" && (
        <p className="result">
          {ticketCount !== null
            ? t("weekly.initialResult", { count: ticketCount, amount: poolDisplay })
            : t("wheel.loading")}
        </p>
      )}
      {result.kind === "won" && (
        <>
          <p className="result">
            {t("wheel.winPrefix")} <strong>{result.winner}</strong>
          </p>
          <p className="result">{t("weekly.continuePrompt")}</p>
        </>
      )}
      </div>

      <div className="lab-screen-stats">
        {loaded ? (
          <>
            {/* The prize banner up top already carries this (see
                .prize-round-badge/weekBadge in WeeklyWheelCard's own JSX
                above), but it reads as decorative there and easy to miss -
                reported live ("en ningun lado veo que ronda es actualmente
                en weekly"). Repeating it here, next to the other per-week
                numbers a player actually checks against, is where they
                expect it. */}
            <p>{t("weekly.weekBadge", { weekId: weekState.week.week_id })}</p>
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
