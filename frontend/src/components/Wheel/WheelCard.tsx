import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BulbRing } from "./BulbRing";
import { BuntingRow } from "./BuntingRow";
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
import type { WheelRoundState } from "../../hooks/useWheelRound";
import { PRIZE_SHARE } from "../../lib/queryWheelManager";
import { formatUluna } from "../../lib/format";
import { useWallet } from "../../contexts/WalletContext";
import { closeRound, drawWinner, expireRound, reclaimTicket, withdrawTicket } from "../../lib/roundActions";
import { markRevealed } from "../../lib/revealCache";
import { WHEEL_MANAGER_ADDRESS } from "../../lib/deployment";
import { VerifyRoundPanel } from "./VerifyRoundPanel";
import { RedeemBox } from "./RedeemBox";

const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

type ResultState =
  | { kind: "idle" }
  | { kind: "spinning" }
  | { kind: "won"; winner: string };

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
}: WheelCardProps) {
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
  // Distinguishes "I'm the one who just closed/drew this round" from "I
  // showed up after someone else already did" - both land on the same
  // status === "drawn" state and still need an explicit Spin click to watch
  // the reveal, so the only way to tell them apart is tracking whether this
  // browser tab was the one that fired the DrawWinner tx.
  const [triggeredDraw, setTriggeredDraw] = useState(false);

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
  const pegBoundaryOffsets = useMemo(() => buildPegBoundaryOffsets(arcs), [arcs]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawWheel(ctx, currentRotationRef.current, arcs);

    // Bungee paints the "Nx" segment labels; force one redraw once it's
    // actually loaded so the very first paint isn't a fallback-font flash
    // (canvas text doesn't repaint on its own when a @font-face resolves).
    if (document.fonts?.load) {
      document.fonts
        .load("400 15px Bungee")
        .then(() => drawWheel(ctx, currentRotationRef.current, arcs))
        .catch(() => {});
    }
  }, [arcs]);

  // Ticks every second so the countdown reads live and the close button
  // enables itself the instant the deadline passes, without the player
  // needing to do anything to trigger a re-render.
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

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

    // Land somewhere inside the winner's own slice, not always dead-center -
    // real physical stopping points aren't perfectly centered. Keeps a margin
    // from both edges so the pointer never looks ambiguously close to a peg.
    const segSpan = winnerArc.end - winnerArc.start;
    const edgeMargin = 0.18;
    const landingAngle =
      winnerArc.start +
      segSpan * edgeMargin +
      Math.random() * segSpan * (1 - 2 * edgeMargin);

    // Always travel at least MIN_EXTRA_SPINS full turns from wherever the
    // wheel currently sits, then just enough extra to land the winner under
    // the pointer - never a fixed absolute angle, which previously could put
    // the "target" only a fraction of a turn ahead of a mid/late startRotation
    // (the wheel would barely move before landing on a neighboring segment).
    const MIN_EXTRA_SPINS = 20;

    const desiredFinalMod = normalize(POINTER_ANGLE - landingAngle);
    const startRotation = currentRotationRef.current;
    const currentMod = normalize(startRotation);
    let deltaToAlign = desiredFinalMod - currentMod;
    if (deltaToAlign < 0) deltaToAlign += TWO_PI;

    const totalRotation = MIN_EXTRA_SPINS * TWO_PI + deltaToAlign;
    const targetRotation = startRotation + totalRotation;

    // Only ~16% of the time is the fast cruise - braking starts early and
    // gets the other ~84% of the time (and most of the rotation) to unfold
    // slowly, so there's real distance between "it starts slowing down" and
    // "it actually stops."
    const CRUISE_FRACTION = 0.16;
    const duration = 8200;
    const startTime = performance.now();
    let lastTickIndex = -1;

    function frame(now: number) {
      const t = Math.min(1, (now - startTime) / duration);
      const progress = wheelProgress(t, CRUISE_FRACTION);
      const rot = startRotation + totalRotation * progress;

      drawWheel(ctx!, rot, arcs);

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
        if (walletState.status === "connected" && roundState.status === "loaded") {
          markRevealed(
            contractAddress ?? WHEEL_MANAGER_ADDRESS,
            roundState.round.round_id,
            walletState.address
          );
          onRevealed?.();
        }
      }
    }
    requestAnimationFrame(frame);
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

  async function handleDrawWinner() {
    if (walletState.status !== "connected" || roundState.status !== "loaded") return;
    const drawnRoundId = roundState.round.round_id;
    setActionBusy("drawing");
    setActionError(null);
    try {
      await drawWinner(walletState.wallet, contractAddress);
      setTriggeredDraw(true);
      onRoundFinished(drawnRoundId);
    } catch (err) {
      // Matches contracts/wheel-manager/src/error.rs's actual Display text
      // for ContractError::DrawTooEarly, not the Rust variant name (which
      // never appears in the raw_log).
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
    setResult({ kind: "idle" });
    currentRotationRef.current = 0;
    setJustReclaimed(false);
    setJustWithdrawn(false);
    setTriggeredDraw(false);
    onContinue();
  }

  // Prize/pool/ticket-price come from the live round query.
  const loaded = roundState.status === "loaded";
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

  function formatCountdown(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div className="wheel-card">
      <div className="tent-scallop" />
      <BuntingRow count={22} />
      <div className="prize-tag">
        {loaded && (
          <p className="prize-round-badge">{t("wheel.roundBadge", { roundId: roundState.round.round_id })}</p>
        )}
        <p className="prize-label">🏆 {t("wheel.prizeLabel")}</p>
        <div className="prize-row">
          <span className="prize-amount">{prizeDisplay}</span>
          {roiPercent !== null && (
            <span className="prize-roi">
              {roiPercent >= 0 ? "+" : ""}
              {roiPercent}%
            </span>
          )}
        </div>
        <p className="prize-roi-caption">
          {t("wheel.roiCaption", { price: ticketPriceDisplay })}
        </p>
      </div>

      <div className="wheel-wrap">
        <BulbRing />
        <div className="pointer" ref={pointerRef} />
        <canvas id="wheel" ref={canvasRef} width={340} height={340} />
        <div className="hub">
          <div className="hub-spiral" />
        </div>
      </div>

      {loaded && roundState.round.status === "open" && (
        closeEligible ? (
          <button
            className="round-action-btn"
            onClick={handleCloseRound}
            disabled={actionBusy !== "idle" || walletState.status !== "connected"}
          >
            {actionBusy === "closing" ? t("wheel.closing") : t("wheel.closeRound")}
          </button>
        ) : expireEligible ? (
          <button
            className="round-action-btn"
            onClick={handleExpireRound}
            disabled={actionBusy !== "idle" || walletState.status !== "connected"}
          >
            {actionBusy === "expiring" ? t("wheel.expiring") : t("wheel.expireRound")}
          </button>
        ) : secondsToDeadline !== null ? (
          <p className="round-status-note">
            {t(secondsToDeadline <= 20 ? "wheel.closesInUrgent" : "wheel.closesIn", {
              time: formatCountdown(secondsToDeadline),
            })}
          </p>
        ) : (
          <p className="round-status-note">
            {t("wheel.waitingForMinPlayers", { min: roundState.config.min_players })}
          </p>
        )
      )}

      {loaded && roundState.round.status === "open" && roundState.round.round_id > 1 && (
        <button
          type="button"
          className="round-action-btn"
          onClick={() => onViewRound?.(roundState.round.round_id - 1)}
        >
          {t("wheel.viewPreviousRound", { roundId: roundState.round.round_id - 1 })}
        </button>
      )}

      {loaded &&
        roundState.round.status === "open" &&
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

      {loaded && roundState.round.status === "closed" && (
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

      {loaded && roundState.round.status === "expired" && (
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
            {t("wheel.continueNextRound")}
          </button>
        </>
      )}

      {loaded && roundState.round.status === "drawn" && result.kind !== "won" && (
        <>
          <p className="round-status-note">
            {t(triggeredDraw ? "wheel.drawnByYou" : "wheel.drawnByOther")}
          </p>
          <button
            className="spin-btn"
            onClick={() => roundState.round.winner && spinToWinner(roundState.round.winner)}
            disabled={spinning || !roundState.round.winner}
          >
            {t("wheel.spin")}
          </button>
        </>
      )}

      {result.kind === "won" && (
        <>
          {loaded &&
            walletState.status === "connected" &&
            roundState.round.winner === walletState.address &&
            roundState.round.prize_remaining !== "0" && (
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
            )}
          <button className="round-action-btn" onClick={handleContinue}>
            {t("wheel.continueNextRound")}
          </button>
        </>
      )}

      {actionError && <p className="round-action-error">{actionError}</p>}

      <p className="result">
        {result.kind === "spinning" && t("wheel.spinning")}
        {result.kind === "idle" &&
          (ticketCount !== null
            ? t("wheel.initialResult", { count: ticketCount, amount: poolDisplay })
            : t("wheel.loading"))}
        {result.kind === "won" && (
          <>
            {t("wheel.winPrefix")} <strong>{result.winner}</strong>{" "}
            {loaded && roundState.round.prize_remaining !== "0"
              ? t("wheel.winSuffix", { amount: formatUluna(roundState.round.prize_remaining, "USDC") })
              : t("wheel.winSuffixRedeemed")}
          </>
        )}
      </p>

      {loaded && roundState.round.status === "drawn" && (
        <VerifyRoundPanel roundId={roundState.round.round_id} contractAddress={contractAddress} />
      )}
    </div>
  );
}
