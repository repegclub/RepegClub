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
  // version. A CSS media-query nudge on the canvas's own `top` worked in
  // every desktop/simulator test but never applied on a real iPhone across
  // Safari, Chrome, and Brave (all WebKit on iOS - one engine), even after
  // clearing cache and switching networks. Baking the nudge into the draw
  // call instead sidesteps whatever that was.
  //
  // Gated on window.innerWidth against the exact same 980px breakpoint
  // .wheel-cabinet itself uses, not on the canvas's own rendered width -
  // that was tried first and mis-fired at desktop sizes too, because the
  // wheel's own %-of-%-of-% container chain (see .wheel-booth-wheel) makes
  // its rendered width land in roughly the same ~150-270px range whether
  // the page is in its wide 3-column layout or its narrow single-column
  // one, with no width gap clean enough to threshold on directly. The
  // layout's own breakpoint has no such ambiguity - it's already confirmed
  // correct on every device this got tested on. `size` is still the fixed
  // internal buffer (340) regardless of display size, so the 7 target
  // screen-px is converted through the buffer/rendered-width ratio to
  // still read as 7px once the browser scales the buffer down to fit
  // whatever the card's actual size turns out to be.
  const isMobileLayout = window.innerWidth < 981;
  const renderedWidth = ctx.canvas.clientWidth || size;
  const MOBILE_NUDGE_PX = 7;
  const cy = size / 2 + (isMobileLayout ? MOBILE_NUDGE_PX * (size / renderedWidth) : 0);

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
