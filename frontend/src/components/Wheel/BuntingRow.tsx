const BUNTING_TEXTURES = ["/flag-blue.jpg", "/flag-red.jpg", "/flag-cream.jpg"];

type BuntingRowProps = {
  count: number;
  className?: string;
};

// Pennant flags (banderines) - purely decorative fairground dressing,
// alternating real fabric-swatch photos (satin blue/red ribbon, cream
// linen) instead of flat color, cycled across the row. Reused under the
// tent-scallop and atop the side lot signage.
export function BuntingRow({ count, className }: BuntingRowProps) {
  return (
    <div className={`bunting${className ? ` ${className}` : ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flag"
          style={{ backgroundImage: `url(${BUNTING_TEXTURES[i % BUNTING_TEXTURES.length]})` }}
        />
      ))}
    </div>
  );
}
