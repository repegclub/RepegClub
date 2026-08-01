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
  // On phone-sized cards (rendered canvas well under its own 340px buffer)
  // a sliver of the booth background's own painted wheel peeks out above
  // the disc - not visible once the card is desktop-sized. A CSS media
  // query nudge (top: calc(5% + 7px) below 980px) fixed this in every
  // simulator/desktop test but a real iPhone (Safari/Chrome/Brave - all
  // WebKit on iOS, so really one engine) never applied it even after
  // clearing cache, closing the tab, and switching networks - baking the
  // same nudge into the draw call sidesteps whatever that was, since it
  // only depends on the canvas's own measured rendered width, not on CSS
  // cascade/media-query evaluation at all. `size` is the fixed internal
  // buffer (340) regardless of display size, so the 7 target screen-px
  // has to be converted through the buffer/rendered-width ratio to still
  // read as 7px once the browser scales the buffer down to fit the card.
  const renderedWidth = ctx.canvas.clientWidth || size;
  const MOBILE_CARD_THRESHOLD = 300;
  const MOBILE_NUDGE_PX = 7;
  const cy =
    size / 2 + (renderedWidth < MOBILE_CARD_THRESHOLD ? MOBILE_NUDGE_PX * (size / renderedWidth) : 0);

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
