// Lightens/darkens a "#rrggbb" hex color by amt (-255..255) per channel -
// purely cosmetic, gives each wheel segment a glossy-enamel gradient
// instead of a flat fill. Does not touch which segment is drawn where.
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + amt);
  const g = clamp(((n >> 8) & 0xff) + amt);
  const b = clamp((n & 0xff) + amt);
  return `rgb(${r},${g},${b})`;
}

// Two physical phases: (1) a constant-speed cruise, then (2) a cubic
// Hermite brake curve. Unlike exponential decay (which never actually
// reaches zero velocity and has to be cut off arbitrarily at t=1 - that
// cutoff is what read as a visible "step" between still-moving and
// stopped), this curve is solved so velocity is continuous at the
// cruise->brake handoff AND lands at *exactly* zero velocity at the
// stop. The deceleration itself is what carries it to zero - no cutoff.
// BRAKE_ENTRY_RATE (M) is how much faster the brake starts than its own
// average pace over the phase; must stay under 3 or the curve briefly
// rolls backward near the end, so this keeps a safety margin below that.
export const BRAKE_ENTRY_RATE = 2.2;

export function wheelProgress(t: number, cruiseFraction: number): number {
  const d1 = cruiseFraction;
  const d2 = 1 - cruiseFraction;
  const M = BRAKE_ENTRY_RATE;
  const v = M / (d2 + M * d1); // cruise speed solved so brake entry ratio is M
  if (t <= d1) return v * t;
  const tau = (t - d1) / d2; // 0..1 local progress within the brake phase
  const q = (M - 2) * tau ** 3 + (3 - 2 * M) * tau ** 2 + M * tau;
  const R = 1 - v * d1; // remaining progress the brake phase must cover
  return v * d1 + R * q;
}
