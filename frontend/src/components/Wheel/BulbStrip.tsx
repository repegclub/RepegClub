type BulbStripProps = {
  position: "top" | "bottom";
  count?: number;
};

export function BulbStrip({ position, count = 16 }: BulbStripProps) {
  return (
    <div className={`bulb-strip ${position}`}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="bulb-mini"
          style={{ animationDelay: `${i * (1.6 / count)}s` }}
        />
      ))}
    </div>
  );
}
