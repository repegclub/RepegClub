import { BulbStrip } from "./BulbStrip";

export function MarqueeSign() {
  return (
    <div className="marquee-sign">
      <BulbStrip position="top" />
      <p className="eyebrow">Repeg Club — prototipo</p>
      <h1>Wheel of Repeg</h1>
      <BulbStrip position="bottom" />
    </div>
  );
}
