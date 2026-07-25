import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { buildArcs, aggregateEntrants } from "../../lib/wheelData";
import { useWheelSpin } from "../../hooks/useWheelSpin";
import { WheelCanvas } from "../Shared/WheelCanvas";
import { isCyolRevealed, markCyolRevealed } from "../../lib/revealCache";

type Props = {
  // Keys the "already watched this reveal" check (see lib/revealCache) -
  // one raffle per contract address, no round_id to key on like Wheel of
  // Repeg has.
  contractAddress: string;
  // Raw one-entry-per-ticket list, same shape as Wheel of Repeg's
  // GetRoundEntrants (see lib/queryCyolRaffle.ts's getEntrants).
  entrants: string[];
  winnerAddress: string;
  // Rendered only once the spin lands - the existing winner/prize/verify
  // markup the caller already had, now gated behind watching the reveal
  // instead of appearing the instant DrawWinner succeeds.
  children: ReactNode;
};

// SingleWinner's reveal moment: the same wheel/physics/confetti Wheel of
// Repeg uses (via useWheelSpin/WheelCanvas), reused as-is so a creator
// streaming or recording a draw gets real suspense instead of the result
// just appearing as text. A raffle already watched in this browser skips
// the wheel entirely and goes straight to the result - otherwise every
// return visit to a raffle's page (a permanent, shareable URL, unlike Wheel
// of Repeg's ephemeral rounds) would force re-clicking "Reveal winner" for
// something already seen.
export function CyolRevealWheel({ contractAddress, entrants, winnerAddress, children }: Props) {
  const { t } = useTranslation();
  const [alreadyRevealed] = useState(() => isCyolRevealed(contractAddress));
  const arcs = useMemo(() => buildArcs(aggregateEntrants(entrants)), [entrants]);
  const { canvasRef, pointerRef, spinning, result, spin } = useWheelSpin(arcs);

  if (alreadyRevealed) return <>{children}</>;

  return (
    <div className="cyol-reveal-wheel">
      <WheelCanvas canvasRef={canvasRef} pointerRef={pointerRef} />
      {result.kind === "won" ? (
        children
      ) : (
        <button
          type="button"
          className="spin-btn"
          onClick={() => spin(winnerAddress, () => markCyolRevealed(contractAddress))}
          disabled={spinning}
        >
          {t(spinning ? "wheel.spinning" : "wheel.spin")}
        </button>
      )}
    </div>
  );
}
