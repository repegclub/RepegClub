import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPegBoundaryOffsets,
  pegsPassed,
  TWO_PI,
  POINTER_ANGLE,
  type Arc,
} from "../lib/wheelData";
import { drawWheel } from "../lib/drawWheel";
import { wheelProgress } from "../lib/wheelPhysics";
import { flickFlapper } from "../lib/flickFlapper";
import { getAudioCtx, playTick, playWinChime } from "../lib/audio";
import { burstConfetti } from "../lib/confetti";

const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

export type WheelSpinResult = { kind: "idle" } | { kind: "spinning" } | { kind: "won"; winner: string };

// The reusable half of what WheelCard used to do inline: canvas drawing,
// physics, tick sound/flapper, confetti+chime on landing. Anything about
// *when* a spin is allowed (round status, redeem, verify panel) stays with
// each caller - this only knows how to animate landing on a given address
// among the arcs it's given.
//
// `draw` defaults to the shared carnival/chrome renderer - Wheel of Repeg's
// pixel-art wheel passes drawPixelWheel instead, which ignores arcs (its
// visual layout is fixed) but still needs the same rotation-per-frame calls.
export function useWheelSpin(arcs: Arc[], draw: (ctx: CanvasRenderingContext2D, rotation: number, arcs: Arc[]) => void = drawWheel) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const currentRotationRef = useRef(0);

  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<WheelSpinResult>({ kind: "idle" });
  const pegBoundaryOffsets = useMemo(() => buildPegBoundaryOffsets(arcs), [arcs]);
  // Guards the rAF loop below against a caller unmounting mid-spin (e.g.
  // navigating away from a raffle page while the wheel is still turning) -
  // without this, `frame` keeps drawing into a detached canvas, ticking
  // sound/haptics, and would eventually fire onLanded/confetti/chime for a
  // component that's no longer there.
  const activeRef = useRef(true);
  useEffect(() => {
    // Re-arm on every (re)mount, not just via useRef's initial value - under
    // StrictMode's dev-only mount->cleanup->mount simulation, hook state
    // survives the simulated remount but this cleanup still runs once, so
    // relying on the initial `true` alone left this permanently false after
    // React's very first commit, silently freezing every future spin.
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    draw(ctx, currentRotationRef.current, arcs);

    // Bungee paints the "Nx" segment labels; force one redraw once it's
    // actually loaded so the very first paint isn't a fallback-font flash
    // (canvas text doesn't repaint on its own when a @font-face resolves).
    if (document.fonts?.load) {
      document.fonts
        .load("400 15px Bungee")
        .then(() => draw(ctx, currentRotationRef.current, arcs))
        .catch(() => {});
    }
  }, [arcs, draw]);

  function reset() {
    setResult({ kind: "idle" });
    setSpinning(false);
    currentRotationRef.current = 0;
  }

  function spin(winnerAddress: string, onLanded?: () => void) {
    const canvas = canvasRef.current;
    // Only used for the old flapper's flick animation - the pixel wheel's
    // pointer is baked into its static frame image and has no ref at all,
    // so this stays optional instead of bailing the whole spin out on it.
    const pointer = pointerRef.current;
    const ctx = canvas?.getContext("2d");
    const winner = arcs.find((a) => a.address === winnerAddress);
    if (!canvas || !ctx || !winner) return;
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
      winnerArc.start + segSpan * edgeMargin + Math.random() * segSpan * (1 - 2 * edgeMargin);

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
      if (!activeRef.current) return;
      const t = Math.min(1, (now - startTime) / duration);
      const progress = wheelProgress(t, CRUISE_FRACTION);
      const rot = startRotation + totalRotation * progress;

      draw(ctx!, rot, arcs);

      const tickIndex = pegsPassed(rot, pegBoundaryOffsets);
      if (tickIndex !== lastTickIndex) {
        lastTickIndex = tickIndex;
        if (pointer) flickFlapper(pointer);
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
        onLanded?.();
      }
    }
    requestAnimationFrame(frame);
  }

  return { canvasRef, pointerRef, spinning, result, spin, reset };
}
