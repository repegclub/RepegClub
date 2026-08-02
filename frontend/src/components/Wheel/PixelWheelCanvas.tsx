import type { RefObject } from "react";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // Weekly Round passes its own jeweled-wheel frame + a distinct CSS class
  // (its ring-hole measurements aren't the same as Wheel of Repeg's, so it
  // needs its own left/top/width/height rule - see weekly.css) instead of
  // duplicating this whole component for a second static-image overlay.
  frameSrc?: string;
  frameClassName?: string;
};

// Wheel of Repeg's pixel-art wheel: the canvas only draws the rotating
// palette disc (see drawPixelWheel.ts); the rim, pegs, hub and pointer are
// one static image on top (frame.png), since none of that spins - a real
// prize wheel's frame is fixed, only the colored disc underneath turns.
// Kept separate from the shared WheelCanvas (still used by Create Your Own
// Luck's carnival/chrome style).
export function PixelWheelCanvas({
  canvasRef,
  frameSrc = "/wheel-pixel/frame.png",
  frameClassName = "pixel-wheel-frame",
}: Props) {
  return (
    <div className="pixel-wheel-wrap">
      <canvas className="pixel-wheel-canvas" ref={canvasRef} width={340} height={340} />
      <img src={frameSrc} alt="" className={frameClassName} />
    </div>
  );
}
