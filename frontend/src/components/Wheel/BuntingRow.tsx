const BUNTING_COLORS = ["var(--blue)", "var(--crimson)", "var(--gold)"];

type BuntingRowProps = {
  count: number;
  className?: string;
};

// Pennant flags (banderines) - purely decorative fairground dressing,
// alternating the three brand colors. Reused under the tent-scallop and
// atop the side lot signage.
export function BuntingRow({ count, className }: BuntingRowProps) {
  return (
    <div className={`bunting${className ? ` ${className}` : ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flag"
          style={{ background: BUNTING_COLORS[i % BUNTING_COLORS.length] }}
        />
      ))}
    </div>
  );
}
