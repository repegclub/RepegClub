export type Entrant = {
  name: string;
  address: string;
  tickets: number;
  color: string;
};

export type Arc = Entrant & {
  start: number;
  end: number;
};

export const TWO_PI = Math.PI * 2;
export const POINTER_ANGLE = -Math.PI / 2;

// Cycled by ticket-buying order (first-seen wallet gets the first color).
// Brand palette plus one neutral tone, matching what the original mock used.
const PALETTE = [
  "#5492f7",
  "#d01e43",
  "#ffd166",
  "#0b3a9e",
  "#ff3a5e",
  "#b8811f",
  "#8890a3",
];

export function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length];
}

export function buildArcs(entrants: Entrant[]): Arc[] {
  const total = entrants.reduce((s, e) => s + e.tickets, 0);
  let angleAcc = POINTER_ANGLE;
  return entrants.map((e) => {
    const span = total > 0 ? (e.tickets / total) * TWO_PI : 0;
    const arc = { ...e, start: angleAcc, end: angleAcc + span };
    angleAcc += span;
    return arc;
  });
}

// Before anyone has bought a ticket, an empty wheel reads as broken rather
// than "ready" - fills it with evenly-sized neutral slots instead. Distinct
// from buildArcs (which weights segments by ticket count): these are always
// equal width, and carry no name/address, so nothing can mistake one for a
// real entrant (spinToWinner matches on address, which is empty here).
const PLACEHOLDER_COLORS = ["#171b2c", "#1e2338"];

export function buildPlaceholderArcs(count: number): Arc[] {
  const span = TWO_PI / count;
  let angleAcc = POINTER_ANGLE;
  return Array.from({ length: count }, (_, i) => {
    const arc: Arc = {
      name: "",
      address: "",
      tickets: 0,
      color: PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.length],
      start: angleAcc,
      end: angleAcc + span,
    };
    angleAcc += span;
    return arc;
  });
}

// The real peg positions (segments are *not* equal width - each entrant's
// arc is sized by their ticket count). Ticking must be keyed off exactly
// these angles, not an imaginary even grid, or the flapper/sound drift out
// of sync with the pegs actually drawn on the wheel.
export function buildPegBoundaryOffsets(arcs: Arc[]): number[] {
  return arcs
    .map((a) => {
      let b = (POINTER_ANGLE - a.start) % TWO_PI;
      if (b < 0) b += TWO_PI;
      return b;
    })
    .sort((x, y) => x - y);
}

export function pegsPassed(rot: number, pegBoundaryOffsets: number[]): number {
  const fullTurns = Math.floor(rot / TWO_PI);
  let rem = rot - fullTurns * TWO_PI;
  if (rem < 0) rem += TWO_PI;
  let count = 0;
  for (let i = 0; i < pegBoundaryOffsets.length; i++) {
    if (pegBoundaryOffsets[i] <= rem) count++;
  }
  return fullTurns * pegBoundaryOffsets.length + count;
}
