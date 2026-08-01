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
  const cy = size / 2;

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
