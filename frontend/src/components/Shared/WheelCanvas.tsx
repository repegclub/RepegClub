import type { RefObject } from "react";
import { BulbRing } from "../Wheel/BulbRing";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pointerRef: RefObject<HTMLDivElement | null>;
};

// The canvas + pointer + hub markup shared by every spinning-wheel reveal
// (Wheel of Repeg, and now Create Your Own Luck) - paired with useWheelSpin,
// which owns the refs this renders and the animation that draws into them.
export function WheelCanvas({ canvasRef, pointerRef }: Props) {
  return (
    <div className="wheel-wrap">
      <BulbRing />
      <div className="pointer" ref={pointerRef} />
      <canvas id="wheel" ref={canvasRef} width={340} height={340} />
      <div className="hub">
        <div className="hub-spiral" />
      </div>
    </div>
  );
}
