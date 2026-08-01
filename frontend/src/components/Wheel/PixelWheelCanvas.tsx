import type { RefObject } from "react";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
};

// Wheel of Repeg's pixel-art wheel: the canvas only draws the rotating
// palette disc (see drawPixelWheel.ts); the rim, pegs, hub and pointer are
// one static image on top (frame.png), since none of that spins - a real
// prize wheel's frame is fixed, only the colored disc underneath turns.
// Kept separate from the shared WheelCanvas (still used by Weekly Round and
// Create Your Own Luck's carnival/chrome style).
export function PixelWheelCanvas({ canvasRef }: Props) {
  return (
    <div className="pixel-wheel-wrap">
      <canvas className="pixel-wheel-canvas" ref={canvasRef} width={340} height={340} />
      <img src="/wheel-pixel/frame.png" alt="" className="pixel-wheel-frame" />
    </div>
  );
}
