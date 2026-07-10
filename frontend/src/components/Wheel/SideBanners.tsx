import { BuntingRow } from "./BuntingRow";

export function SideBanners() {
  return (
    <>
      <div className="side-banner side-banner-left" aria-hidden="true">
        <div className="pin" />
        <BuntingRow count={14} className="side-bunting" />
        The only f*cking REPEG you'll ever get!!!
      </div>
      <div className="side-banner side-banner-right" aria-hidden="true">
        <div className="pin" />
        <BuntingRow count={8} className="side-bunting" />
        Feel lucky?
      </div>
    </>
  );
}
