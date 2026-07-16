import { useEffect, useLayoutEffect, useRef, useState } from "react";

const BULB_COUNT = 28;
const CYCLE_MS = 5000;

// Marquee-controller-style patterns for the "strobe" variant: a rotating
// comet (both directions), a synchronized on/off pulse, and two comets
// chasing 180deg apart. Order deliberately isn't a clean round-robin so it
// doesn't fall into an obviously repeating rhythm within a short viewing.
type Pattern = "chase-right" | "chase-left" | "sync-pulse" | "opposite-cones";
const PATTERNS: Pattern[] = [
  "chase-right",
  "opposite-cones",
  "chase-left",
  "sync-pulse",
  "opposite-cones",
  "chase-right",
  "sync-pulse",
  "chase-left",
];

type BulbColor = { core: string; mid: string; edge: string; glow: string };
const COLORS: BulbColor[] = [
  { core: "#fff0f2", mid: "#ff3a5e", edge: "#d01e43", glow: "rgba(255,58,94,0.6)" }, // red
  { core: "#eaf3ff", mid: "#5492f7", edge: "#0b3a9e", glow: "rgba(84,146,247,0.6)" }, // blue
  { core: "#ffffff", mid: "#f2f3f7", edge: "#c7cbd8", glow: "rgba(255,255,255,0.55)" }, // white
];

function bulbDelay(pattern: Pattern, i: number): number {
  const cycleSeconds = 1.8;
  switch (pattern) {
    case "chase-right":
      return i * (cycleSeconds / BULB_COUNT);
    case "chase-left":
      return (BULB_COUNT - 1 - i) * (cycleSeconds / BULB_COUNT);
    case "sync-pulse":
      return 0;
    case "opposite-cones": {
      const half = BULB_COUNT / 2;
      return (i % half) * (cycleSeconds / half);
    }
  }
}

type BulbRingProps = {
  // "classic" keeps Wheel of Repeg's original always-gold, single-direction
  // chase untouched. "strobe" (Weekly Round) cycles through marquee light
  // patterns and the brand's red/blue/white instead of a fixed warm gold.
  variant?: "classic" | "strobe";
};

export function BulbRing({ variant = "classic" }: BulbRingProps) {
  const ringRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(340);
  const [cycle, setCycle] = useState(0);

  useLayoutEffect(() => {
    const el = ringRef.current;
    if (!el) return;
    const update = () => setBox(el.offsetWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (variant !== "strobe") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setCycle((c) => c + 1), CYCLE_MS);
    return () => clearInterval(id);
  }, [variant]);

  const center = box / 2;
  const radius = center;
  const pattern = PATTERNS[cycle % PATTERNS.length];
  const color = COLORS[cycle % COLORS.length];

  return (
    <div className="bulb-ring" ref={ringRef}>
      {Array.from({ length: BULB_COUNT }, (_, i) => {
        const angle = (i / BULB_COUNT) * Math.PI * 2;
        const x = center + Math.cos(angle) * radius;
        const y = center + Math.sin(angle) * radius;
        const style = (
          variant === "strobe"
            ? {
                left: `${x}px`,
                top: `${y}px`,
                animationDelay: `${bulbDelay(pattern, i)}s`,
                "--bulb-core": color.core,
                "--bulb-mid": color.mid,
                "--bulb-edge": color.edge,
                "--bulb-glow": color.glow,
              }
            : {
                left: `${x}px`,
                top: `${y}px`,
                animationDelay: `${i * (1.8 / BULB_COUNT)}s`,
              }
        ) as React.CSSProperties;
        return (
          <div
            key={variant === "strobe" ? `${cycle}-${i}` : i}
            className="bulb"
            style={style}
          />
        );
      })}
    </div>
  );
}
