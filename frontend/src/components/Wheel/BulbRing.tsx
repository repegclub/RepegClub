const BULB_COUNT = 28;

// Marquee bulbs around the wheel, evenly spaced, chase-lit via staggered
// delay. Positioned to match the .bulb-ring's -18px inset over the 340px
// wheel-wrap (center 179,179, radius 179), same numbers as the prototype.
export function BulbRing() {
  return (
    <div className="bulb-ring">
      {Array.from({ length: BULB_COUNT }, (_, i) => {
        const angle = (i / BULB_COUNT) * Math.PI * 2;
        const radius = 179;
        const x = 179 + Math.cos(angle) * radius;
        const y = 179 + Math.sin(angle) * radius;
        return (
          <div
            key={i}
            className="bulb"
            style={{
              left: `${x}px`,
              top: `${y}px`,
              animationDelay: `${i * (1.8 / BULB_COUNT)}s`,
            }}
          />
        );
      })}
    </div>
  );
}
