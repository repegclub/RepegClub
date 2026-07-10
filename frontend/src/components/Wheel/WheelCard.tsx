import { useEffect, useRef, useState } from "react";
import { BulbRing } from "./BulbRing";
import { BuntingRow } from "./BuntingRow";
import { arcs, pegsPassed, totalTickets, type Arc, TWO_PI, POINTER_ANGLE } from "../../lib/wheelData";
import { drawWheel } from "../../lib/drawWheel";
import { wheelProgress } from "../../lib/wheelPhysics";
import { flickFlapper } from "../../lib/flickFlapper";
import { getAudioCtx, playTick, playWinChime } from "../../lib/audio";
import { burstConfetti } from "../../lib/confetti";

const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

export function WheelCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const currentRotationRef = useRef(0);

  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<{ text: string; winner?: string }>({
    text: "4 tickets vendidos — pool de $6.00",
  });

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawWheel(ctx, currentRotationRef.current);

    // Bungee paints the "Nx" segment labels; force one redraw once it's
    // actually loaded so the very first paint isn't a fallback-font flash
    // (canvas text doesn't repaint on its own when a @font-face resolves).
    if (document.fonts?.load) {
      document.fonts
        .load("400 15px Bungee")
        .then(() => drawWheel(ctx, currentRotationRef.current))
        .catch(() => {});
    }
  }, []);

  function handleSpin() {
    // Must unlock audio synchronously inside the gesture handler itself -
    // mobile browsers (notably iOS Safari) require the AudioContext to be
    // created/resumed within the same call stack as the click/touch event.
    // Desktop browsers are lenient and still allow it from inside the later
    // requestAnimationFrame loop, which is why this silently only broke on
    // mobile: sound worked on desktop Brave, stayed muted on phone.
    getAudioCtx();

    const canvas = canvasRef.current;
    const pointer = pointerRef.current;
    if (!canvas || !pointer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setSpinning(true);
    setResult({ text: "Sorteando…" });

    const roll = Math.random() * totalTickets;
    let acc = 0;
    let winner: Arc = arcs[0];
    for (const a of arcs) {
      acc += a.tickets;
      if (roll <= acc) {
        winner = a;
        break;
      }
    }

    // Land somewhere inside the winner's own slice, not always dead-center -
    // real physical stopping points aren't perfectly centered. Keeps a margin
    // from both edges so the pointer never looks ambiguously close to a peg.
    const segSpan = winner.end - winner.start;
    const edgeMargin = 0.18;
    const landingAngle =
      winner.start +
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
      if (!ctx || !pointer) return;
      const t = Math.min(1, (now - startTime) / duration);
      const progress = wheelProgress(t, CRUISE_FRACTION);
      const rot = startRotation + totalRotation * progress;

      drawWheel(ctx, rot);

      const tickIndex = pegsPassed(rot);
      if (tickIndex !== lastTickIndex) {
        lastTickIndex = tickIndex;
        flickFlapper(pointer);
        playTick();
      }

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        currentRotationRef.current = targetRotation;
        setResult({
          text: `Ganó ${winner.name} — redime hasta $6.00 en USDC`,
          winner: winner.name,
        });
        setSpinning(false);
        if (canvasRef.current) burstConfetti(canvasRef.current);
        playWinChime();
      }
    }
    requestAnimationFrame(frame);
  }

  return (
    <div className="wheel-card">
      <div className="tent-scallop" />
      <BuntingRow count={22} />
      <div className="prize-tag">
        <p className="prize-label">🏆 Premio acumulado</p>
        <div className="prize-row">
          <span className="prize-amount">$6.00</span>
          <span className="prize-roi">+50%</span>
        </div>
        <p className="prize-roi-caption">retorno si ganás con 1 ticket ($4.00)</p>
      </div>

      <div className="wheel-wrap">
        <BulbRing />
        <div className="pointer" ref={pointerRef} />
        <canvas id="wheel" ref={canvasRef} width={340} height={340} />
        <div className="hub">
          <div className="hub-spiral" />
        </div>
      </div>

      <button className="spin-btn" onClick={handleSpin} disabled={spinning}>
        Girar la rueda
      </button>
      <p className="result">
        {result.winner ? (
          <>
            Ganó <strong>{result.winner}</strong> — redime hasta $6.00 en USDC
          </>
        ) : (
          result.text
        )}
      </p>
    </div>
  );
}
