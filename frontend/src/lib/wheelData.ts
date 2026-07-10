export type Entrant = {
  name: string;
  tickets: number;
  color: string;
};

export type Arc = Entrant & {
  start: number;
  end: number;
};

export const TWO_PI = Math.PI * 2;
export const POINTER_ANGLE = -Math.PI / 2;

// Mock data - matches the approved Artifact prototype 1:1. Will be replaced
// by live on-chain round data once the wheel is wired up to the contract.
export const entrants: Entrant[] = [
  { name: "terra1a9f...k3lp", tickets: 3, color: "#5492f7" },
  { name: "terra1x7m...92qw", tickets: 1, color: "#0b3a9e" },
  { name: "terra1qv2...7zt4", tickets: 2, color: "#d01e43" },
  { name: "terra1h4d...bx91", tickets: 1, color: "#8890a3" },
];

export const totalTickets = entrants.reduce((s, e) => s + e.tickets, 0);

let angleAcc = POINTER_ANGLE;
export const arcs: Arc[] = entrants.map((e) => {
  const span = (e.tickets / totalTickets) * TWO_PI;
  const arc = { ...e, start: angleAcc, end: angleAcc + span };
  angleAcc += span;
  return arc;
});

// The real peg positions (segments are *not* equal width - each entrant's
// arc is sized by their ticket count). Ticking must be keyed off exactly
// these angles, not an imaginary even grid, or the flapper/sound drift out
// of sync with the pegs actually drawn on the wheel.
export const pegBoundaryOffsets: number[] = arcs
  .map((a) => {
    let b = (POINTER_ANGLE - a.start) % TWO_PI;
    if (b < 0) b += TWO_PI;
    return b;
  })
  .sort((x, y) => x - y);

export function pegsPassed(rot: number): number {
  const fullTurns = Math.floor(rot / TWO_PI);
  let rem = rot - fullTurns * TWO_PI;
  if (rem < 0) rem += TWO_PI;
  let count = 0;
  for (let i = 0; i < pegBoundaryOffsets.length; i++) {
    if (pegBoundaryOffsets[i] <= rem) count++;
  }
  return fullTurns * pegBoundaryOffsets.length + count;
}
