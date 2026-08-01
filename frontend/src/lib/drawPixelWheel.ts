// Wheel of Repeg's new pixel-art wheel: a single fixed prize layout (not
// derived from real entrants/tickets), so unlike drawWheel.ts this doesn't
// take `arcs` - only the palette disc image is drawn here, rotated. The
// static rim/pegs/hub/pointer live in a separate frame.png layered on top
// by PixelWheelCanvas (not part of this canvas at all), matching how a real
// prize wheel's fixed frame doesn't spin with the disc underneath it.
let paletteImg: HTMLImageElement | null = null;
let paletteLoaded = false;
const paletteWaiters: Array<() => void> = [];

function getPaletteImage(onLoad?: () => void): HTMLImageElement | null {
  if (!paletteImg) {
    paletteImg = new Image();
    paletteImg.src = "/wheel-pixel/palette.png";
    paletteImg.onload = () => {
      paletteLoaded = true;
      paletteWaiters.splice(0).forEach((cb) => cb());
    };
    // Without this, a failed load (offline, bad deploy) would leave
    // paletteLoaded false forever - every future redraw request just keeps
    // pushing another callback onto paletteWaiters with nothing to ever
    // drain it.
    paletteImg.onerror = () => {
      paletteWaiters.splice(0);
    };
  }
  if (!paletteLoaded && onLoad) paletteWaiters.push(onLoad);
  return paletteLoaded ? paletteImg : null;
}

// Second param matches drawWheel's (ctx, rotation, arcs, size) shape so it
// can be passed as a drop-in `draw` override to useWheelSpin - arcs is
// intentionally unused, since this wheel's layout never depends on them.
export function drawPixelWheel(ctx: CanvasRenderingContext2D, rotation: number, _arcs?: unknown, size = 340) {
  const cx = size / 2;
  // Below .wheel-cabinet's own row->single-column breakpoint (see wheel.css)
  // a sliver of the booth background's own painted wheel peeks out above
  // the disc - not visible once the layout is wide enough for the row
  // version. Gated on window.innerWidth against that same 980px breakpoint,
  // not on the canvas's own rendered width - the wheel's %-of-%-of-%
  // container chain (see .wheel-booth-wheel) lands its rendered width in
  // roughly the same ~150-270px range in both layouts, with no width gap
  // clean enough to threshold on directly (confirmed: that mis-fired at
  // desktop sizes too).
  //
  // A flat fraction of `size` (the fixed 340px buffer), not a target
  // screen-px converted through the canvas's measured clientWidth - the
  // clientWidth version overshot in Responsively's iPhone 12/iPad presets
  // (both still narrower than 981px) while looking correct on a real
  // iPhone at the same logical width, pointing at clientWidth being read
  // before layout had fully settled in one of those environments and not
  // the other. Reading `size` instead of the DOM removes that timing
  // dependency entirely - it's a compile-time constant, never wrong to
  // measure early.
  const isMobileLayout = window.innerWidth < 981;
  const MOBILE_NUDGE_FRACTION = 0.012;
  const cy = size / 2 + (isMobileLayout ? size * MOBILE_NUDGE_FRACTION : 0);

  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;

  const img = getPaletteImage(() => drawPixelWheel(ctx, rotation, _arcs, size));
  if (!img) return;

  // Drawn a couple percent oversized so its edge sits under the static
  // frame's rim - hides the palette's own (hand-cut, not pixel-perfect)
  // outer edge instead of letting a sliver of it peek out past the border.
  const OVERSIZE = 1.02;
  const s = size * OVERSIZE;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.drawImage(img, -s / 2, -s / 2, s, s);
  ctx.restore();
}
