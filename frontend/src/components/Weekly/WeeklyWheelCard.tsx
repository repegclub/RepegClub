import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BulbRing } from "../Wheel/BulbRing";
import { BuntingRow } from "../Wheel/BuntingRow";
import { HubSpiral, HubLetters } from "./HubSpiral";
import {
  buildArcs,
  buildPegBoundaryOffsets,
  buildPlaceholderArcs,
  pegsPassed,
  type Entrant,
  TWO_PI,
  POINTER_ANGLE,
} from "../../lib/wheelData";
import { drawWheel } from "../../lib/drawWheel";
import { wheelProgress } from "../../lib/wheelPhysics";
import { flickFlapper } from "../../lib/flickFlapper";
import { getAudioCtx, playTick, playWinChime } from "../../lib/audio";
import { burstConfetti } from "../../lib/confetti";
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

const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

// Bigger and chrome-styled - see the request this was built from: more
// visual impact for "the big one" than Wheel of Repeg's per-tier wheels, a
// metallic sheen instead of a flat color fill. See lib/drawWheel.ts.
const WEEKLY_WHEEL_SIZE = 460;

type ResultState =
  | { kind: "idle" }
  | { kind: "spinning" }
  | { kind: "won"; winner: string };

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const currentRotationRef = useRef(0);

  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<ResultState>({ kind: "idle" });
  const [actionBusy, setActionBusy] = useState<
    "idle" | "closing" | "drawing" | "expiring" | "reclaiming" | "withdrawing"
  >("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [justReclaimed, setJustReclaimed] = useState(false);
  const [justWithdrawn, setJustWithdrawn] = useState(false);
  const [triggeredDraw, setTriggeredDraw] = useState(false);

  useEffect(() => {
    setJustWithdrawn(false);
    setJustReclaimed(false);
  }, [purchaseVersion]);

  const maxPlayers = weekState.status === "loaded" ? weekState.config.max_players : 10;
  const arcs = useMemo(
    () => (entrants.length > 0 ? buildArcs(entrants) : buildPlaceholderArcs(maxPlayers)),
    [entrants, maxPlayers]
  );
  const pegBoundaryOffsets = useMemo(() => buildPegBoundaryOffsets(arcs), [arcs]);

  // The canvas is drawn in a fixed WEEKLY_WHEEL_SIZE logical coordinate
  // space (see drawWheel.ts) but CSS displays it anywhere from ~220px to
  // 460px depending on viewport. Without a backing store sized for the
  // display's actual pixel density, retina screens stretch a soft
  // WEEKLY_WHEEL_SIZE-native bitmap over 2x+ as many physical pixels,
  // reading as low-quality. Size the backing store for devicePixelRatio
  // and scale the context so drawWheel's own math is untouched.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WEEKLY_WHEEL_SIZE * dpr;
    canvas.height = WEEKLY_WHEEL_SIZE * dpr;
    ctx.scale(dpr, dpr);
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawWheel(ctx, currentRotationRef.current, arcs, WEEKLY_WHEEL_SIZE, "chrome");
    if (document.fonts?.load) {
      document.fonts
        .load("400 15px Bungee")
        .then(() => drawWheel(ctx, currentRotationRef.current, arcs, WEEKLY_WHEEL_SIZE, "chrome"))
        .catch(() => {});
    }
  }, [arcs]);

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
    const canvas = canvasRef.current;
    const pointer = pointerRef.current;
    const ctx = canvas?.getContext("2d");
    const winner = arcs.find((a) => a.address === winnerAddress);
    if (!canvas || !pointer || !ctx || !winner) return;
    const winnerArc = winner;

    getAudioCtx();
    setSpinning(true);
    setResult({ kind: "spinning" });

    const segSpan = winnerArc.end - winnerArc.start;
    const edgeMargin = 0.18;
    const landingAngle =
      winnerArc.start + segSpan * edgeMargin + Math.random() * segSpan * (1 - 2 * edgeMargin);

    const MIN_EXTRA_SPINS = 20;
    const desiredFinalMod = normalize(POINTER_ANGLE - landingAngle);
    const startRotation = currentRotationRef.current;
    const currentMod = normalize(startRotation);
    let deltaToAlign = desiredFinalMod - currentMod;
    if (deltaToAlign < 0) deltaToAlign += TWO_PI;

    const totalRotation = MIN_EXTRA_SPINS * TWO_PI + deltaToAlign;
    const targetRotation = startRotation + totalRotation;

    const CRUISE_FRACTION = 0.16;
    const duration = 8200;
    const startTime = performance.now();
    let lastTickIndex = -1;

    function frame(now: number) {
      const t = Math.min(1, (now - startTime) / duration);
      const progress = wheelProgress(t, CRUISE_FRACTION);
      const rot = startRotation + totalRotation * progress;

      drawWheel(ctx!, rot, arcs, WEEKLY_WHEEL_SIZE, "chrome");

      const tickIndex = pegsPassed(rot, pegBoundaryOffsets);
      if (tickIndex !== lastTickIndex) {
        lastTickIndex = tickIndex;
        flickFlapper(pointer!);
        playTick();
      }

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        currentRotationRef.current = targetRotation;
        setResult({ kind: "won", winner: winnerArc.name });
        setSpinning(false);
        if (canvasRef.current) burstConfetti(canvasRef.current);
        playWinChime();
        if (walletState.status === "connected" && weekState.status === "loaded") {
          markRevealed(contractAddress ?? WEEKLY_ROUND_ADDRESS, weekState.week.week_id, walletState.address);
          onRevealed?.();
        }
      }
    }
    requestAnimationFrame(frame);
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
    setResult({ kind: "idle" });
    currentRotationRef.current = 0;
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

  function formatCountdown(totalSeconds: number): string {
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div className="wheel-card weekly-wheel-card">
      <BuntingRow count={15} />
      <div className="prize-tag">
        {loaded && (
          <p className="prize-round-badge">{t("weekly.weekBadge", { weekId: weekState.week.week_id })}</p>
        )}
        <p className="prize-label">👑 {t("weekly.prizeLabel")}</p>
        <div className="prize-row">
          <span className="prize-amount">{prizeDisplay}</span>
        </div>
        <p className="prize-roi-caption">{t("weekly.todayPriceCaption", { price: todayPriceDisplay })}</p>
      </div>

      <div className="wheel-wrap weekly-wheel-wrap">
        <BulbRing variant="strobe" />
        <div className="pointer" ref={pointerRef} />
        <canvas id="weekly-wheel" ref={canvasRef} width={WEEKLY_WHEEL_SIZE} height={WEEKLY_WHEEL_SIZE} />
        <div className="hub weekly-hub">
          <HubSpiral />
          <div className="hub-gloss" />
          <HubLetters lettersMode="alternate" />
          <div className="hub-diamond" />
        </div>
      </div>

      {loaded && weekState.week.status === "open" && (
        closeEligible ? (
          <button
            className="round-action-btn"
            onClick={handleCloseWeek}
            disabled={actionBusy !== "idle" || walletState.status !== "connected"}
          >
            {actionBusy === "closing" ? t("wheel.closing") : t("weekly.closeWeek")}
          </button>
        ) : expireEligible ? (
          <button
            className="round-action-btn"
            onClick={handleExpireWeek}
            disabled={actionBusy !== "idle" || walletState.status !== "connected"}
          >
            {actionBusy === "expiring" ? t("wheel.expiring") : t("wheel.expireRound")}
          </button>
        ) : secondsToDeadline !== null ? (
          <p className="round-status-note">
            {t("weekly.closesIn", { time: formatCountdown(secondsToDeadline) })}
          </p>
        ) : (
          <p className="round-status-note">
            {t("wheel.waitingForMinPlayers", { min: weekState.config.min_players })}
          </p>
        )
      )}

      {loaded && weekState.week.status === "open" && weekState.week.week_id > 1 && (
        <button
          type="button"
          className="round-action-btn round-action-btn-compact"
          onClick={() => onViewWeek?.(weekState.week.week_id - 1)}
        >
          {t("weekly.viewPreviousWeek", { weekId: weekState.week.week_id - 1 })}
        </button>
      )}

      {loaded &&
        weekState.week.status === "open" &&
        !hasMinPlayers &&
        walletState.status === "connected" &&
        entrants.some((e) => e.address === walletState.address) && (
          <>
            {justWithdrawn ? (
              <p className="round-status-note">{t("wheel.withdrawnNote")}</p>
            ) : (
              <>
                <button
                  className="round-action-btn round-action-btn-secondary"
                  onClick={handleWithdrawTicket}
                  disabled={actionBusy !== "idle"}
                >
                  {actionBusy === "withdrawing" ? t("wheel.withdrawing") : t("wheel.withdrawTicket")}
                </button>
                <p className="withdraw-lockin-note">{t("wheel.withdrawLockInNote")}</p>
              </>
            )}
          </>
        )}

      {loaded && weekState.week.status === "closed" && (
        <>
          <p className="round-status-note">{t("wheel.closedWaitingDraw")}</p>
          <button
            className="round-action-btn"
            onClick={handleDrawWinner}
            disabled={actionBusy !== "idle" || walletState.status !== "connected"}
          >
            {actionBusy === "drawing" ? t("wheel.drawing") : t("wheel.drawWinner")}
          </button>
        </>
      )}

      {loaded && weekState.week.status === "expired" && (
        <>
          <p className="round-status-note">{t("wheel.expiredNote")}</p>
          {justReclaimed && <p className="round-status-note">{t("wheel.reclaimedNote")}</p>}
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
        <>
          <p className="round-status-note">{t(triggeredDraw ? "wheel.drawnByYou" : "wheel.drawnByOther")}</p>
          <button
            className="spin-btn"
            onClick={() => weekState.week.winner && spinToWinner(weekState.week.winner)}
            disabled={spinning || !weekState.week.winner}
          >
            {t("wheel.spin")}
          </button>
        </>
      )}

      {result.kind === "won" && (
        <>
          {loaded &&
            walletState.status === "connected" &&
            weekState.week.winner === walletState.address &&
            weekState.week.prize_remaining !== "0" && (
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
            )}
          <button className="round-action-btn" onClick={handleContinue}>
            {t("weekly.continueNextWeek")}
          </button>
        </>
      )}

      {actionError && <p className="round-action-error">{actionError}</p>}

      <p className="result">
        {result.kind === "spinning" && t("wheel.spinning")}
        {result.kind === "idle" &&
          (ticketCount !== null
            ? t("weekly.initialResult", { count: ticketCount, amount: poolDisplay })
            : t("wheel.loading"))}
        {result.kind === "won" && (
          <>
            {t("wheel.winPrefix")} <strong>{result.winner}</strong>{" "}
            {loaded && weekState.week.prize_remaining !== "0"
              ? t("wheel.winSuffix", { amount: formatUluna(weekState.week.prize_remaining, "USDC") })
              : t("wheel.winSuffixRedeemed")}
          </>
        )}
      </p>

      {loaded && weekState.week.status === "drawn" && (
        <WeeklyVerifyRoundPanel weekId={weekState.week.week_id} contractAddress={contractAddress} />
      )}
    </div>
  );
}
