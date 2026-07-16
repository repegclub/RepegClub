// The white wedge is muted a bit further from a pure near-white so the gold
// "R" on it still reads clearly (gold on near-white had almost no contrast).
const WEDGE_COLORS = ["#ccd2e0", "#b81638", "#1d4fa6", "#ccd2e0", "#b81638", "#1d4fa6"];
// Ordered so the shown wedges in "alternate" mode (indices 0, 2, 4) read
// R, P, C clockwise; indices 1/3/5 mirror their color's letter for "all" mode.
const WEDGE_LETTERS = ["R", "C", "P", "R", "C", "P"];

type LettersMode = "all" | "alternate";

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function wedgePath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const p1 = polar(cx, cy, r, startDeg);
  const p2 = polar(cx, cy, r, endDeg);
  return `M ${cx} ${cy} L ${p1.x} ${p1.y} A ${r} ${r} 0 0 1 ${p2.x} ${p2.y} Z`;
}

// Replaces the plain CSS conic-gradient hub-spiral with an SVG - the 6
// color wedges plus a domed glass highlight. Letters are a separate
// component (see HubLetters below) painted above .hub-gloss instead of
// inside this SVG, so hub-gloss's blend-mode overlay (which brightens the
// top of the disc and darkens the bottom) doesn't wash the gold out.
export function HubSpiral() {
  return (
    <svg className="hub-spiral" viewBox="0 0 100 100">
      <defs>
        <radialGradient id="hubDome" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="42%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.28" />
        </radialGradient>
      </defs>
      {WEDGE_COLORS.map((color, i) => (
        <path key={i} d={wedgePath(50, 50, 50, i * 60, (i + 1) * 60)} fill={color} />
      ))}
      <circle cx={50} cy={50} r={50} fill="url(#hubDome)" />
    </svg>
  );
}

// The embossed gold RePegClub initials (R/P/C), rotating in sync with
// HubSpiral (same className drives the shared position/animation CSS) but
// painted after .hub-gloss so its lighting overlay can't dim/wash them.
export function HubLetters({ lettersMode }: { lettersMode: LettersMode }) {
  return (
    <svg className="hub-spiral" viewBox="0 0 100 100">
      <defs>
        {/* Radial (not directional) so brightness stays consistent no
            matter which way a given letter is rotated. */}
        <radialGradient id="hubGoldLetter" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#fff4c2" />
          <stop offset="55%" stopColor="#ffd166" />
          <stop offset="100%" stopColor="#b8811f" />
        </radialGradient>
        <filter id="hubGoldEmboss" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0.24" dy="0.24" stdDeviation="0" floodColor="#5c3d0d" floodOpacity="0.9" />
          <feDropShadow dx="-0.16" dy="-0.16" stdDeviation="0" floodColor="#fff8e0" floodOpacity="0.8" />
        </filter>
      </defs>
      {WEDGE_LETTERS.map((letter, i) => {
        if (lettersMode === "alternate" && i % 2 === 1) return null;
        // Anchored at its base, just outside the diamond, then rotated so
        // it stands up radially - base at center, top pointing outward.
        const midAngle = i * 60 + 30;
        const base = polar(50, 50, 15, midAngle);
        return (
          <text
            key={i}
            x={base.x}
            y={base.y}
            transform={`rotate(${midAngle}, ${base.x}, ${base.y})`}
            fontFamily="'Times New Roman', Georgia, 'Playfair Display', serif"
            fontSize={21.6}
            textAnchor="middle"
            fill="url(#hubGoldLetter)"
            filter="url(#hubGoldEmboss)"
          >
            {letter}
          </text>
        );
      })}
    </svg>
  );
}
