import { useEffect, useMemo, useState } from "react";
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
import { closeRound, drawWinner, expireRound, reclaimTicket, withdrawTicket } from "../../lib/roundActions";
import { markRevealed } from "../../lib/revealCache";
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
    reset();
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
        return { type: "horizontal", message: t("wheel.closesIn", { time: formatCountdown(secondsToDeadline) }) };
      }
      if (secondsToDeadline === null) {
        return { type: "horizontal", message: t("wheel.waitingForMinPlayers", { min: roundState.config.min_players }) };
      }
    }
    if (roundState.round.status === "closed") {
      return { type: "horizontal", message: t("wheel.closedWaitingDraw") };
    }
    if (roundState.round.status === "expired" && justReclaimed) {
      return { type: "horizontal", message: t("wheel.reclaimedNote") };
    }
    if (roundState.round.status === "drawn" && result.kind !== "won" && triggeredDraw) {
      return { type: "rectangulo", message: t("wheel.drawnByYou") };
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

      {loaded && roundState.round.status === "closed" && (
        <button
          className="round-action-btn"
          onClick={handleDrawWinner}
          disabled={actionBusy !== "idle" || walletState.status !== "connected"}
        >
          {actionBusy === "drawing" ? t("wheel.drawing") : t("wheel.drawWinner")}
        </button>
      )}

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
        <div className={`verify-continue-row${isWinnerWithPrize ? "" : " verify-continue-row-solo"}`}>
          <VerifyRoundPanel roundId={roundState.round.round_id} contractAddress={contractAddress} />
          {isWinnerWithPrize && (
            <button className="verify-open-btn continue-next-btn" onClick={handleContinue}>
              {t("wheel.continueShort").split("\n").map((line, i) => (
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

      <div className="lab-screen-message">
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

      {/* closedWaitingDraw is skipped here too - the Host already says it
          (see hostBubble above). */}

      {/* reclaimedNote is skipped here too, same pattern - the Host already
          says it (see hostBubble above). expiredNote stays, it's long. */}
      {loaded && roundState.round.status === "expired" && (
        <p className="round-status-note">{t("wheel.expiredNote")}</p>
      )}

      {/* drawnByYou is skipped here too, same reason - the Host already
          says it (see hostBubble above). drawnByOther is long enough
          (and a different audience: the player who DIDN'T trigger the
          draw) that it stays as plain card text. */}
      {loaded && roundState.round.status === "drawn" && result.kind !== "won" && !triggeredDraw && (
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
        {ticketCount !== null ? (
          <>
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
