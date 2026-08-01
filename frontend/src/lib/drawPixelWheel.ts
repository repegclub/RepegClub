// Wheel of Repeg's new pixel-art wheel: a single fixed prize layout (not
// derived from real entrants/tickets), so unlike drawWheel.ts this doesn't
// take `arcs` - only the palette disc image is drawn here, rotated. The
// static rim/pegs/pointer live in a separate frame.png layered on top by
// PixelWheelCanvas (not part of this canvas at all), matching how a real
// prize wheel's fixed frame doesn't spin with the disc underneath it.
//
// The center hub is baked into palette.png (spins with the disc), not into
// frame.png - an earlier version had the hub as part of the static frame,
// which meant TWO independent static elements (the outer rim AND the hub)
// each had to separately align with the rotating disc. Any small alignment
// error - and there was one, visible only on small/mobile-rendered cards,
// most likely sub-pixel rounding from scaling two independent raster
// layers down - showed up as a sliver of whatever sat behind the mismatch.
// Baking the hub into the disc collapses that to a single boundary (disc
// vs. outer rim only), which is what actually lets OVERSIZE below give
// real forgiveness instead of just trading a gap at the rim for a gap
// around the hub.
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
// palette.png is a 396x396 circular crop (forced to a true circle by the
// crop itself, not just eyeballed round) - an earlier, uncropped version of
// this art had up to ~17px of radius variation depending on angle (a real
// roundness imperfection, confirmed with two independent circle fits, not
// a measurement error), which no amount of rotation-origin precision could
// fix since the shape itself wasn't a circle. This crop is what actually
// fixes that: measured boundary-to-center distance now only varies
// ~194-198px (see the file's own history for the old numbers if this ever
// needs comparing again).
//
// The rotation origin is the HUB's own center, not the disc's outer-edge
// center (199.90,196.21 vs. 197.50,197.38) - a few px of rotation-origin
// error is a small fraction of the disc's ~198px radius, barely visible,
// but the same few px is a large fraction of the hub's own ~46px radius -
// wobble shows up there first and worst. Re-measure both centers (isolate
// the hub by its own teal-ring color/dark outline, not just alpha - the
// hub sits inside a solid disc now, alpha alone can't separate it from
// the pie slices around it) if palette.png is ever replaced.
const HUB_NATIVE_CX = 199.9;
const HUB_NATIVE_CY = 196.21;
const DISC_NATIVE_R = 197.85;

export function drawPixelWheel(ctx: CanvasRenderingContext2D, rotation: number, _arcs?: unknown, size = 340) {
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;

  const img = getPaletteImage(() => drawPixelWheel(ctx, rotation, _arcs, size));
  if (!img) return;

  // Oversized so the disc's edge sits comfortably under the static frame's
  // rim (see PixelWheelCanvas/.pixel-wheel-frame) instead of exactly
  // matching it - real forgiveness now that the hub travels with the disc
  // (see the file-level comment above), not just trading a gap at the rim
  // for one at the hub the way a bigger OVERSIZE used to. OVERSIZE=1.06
  // fixes the disc's on-screen radius at 53% (OVERSIZE*50) of
  // .pixel-wheel-wrap's own width - deliberately independent of
  // .pixel-wheel-canvas's own CSS size (130% of the wrap, for clipping
  // clearance - see that rule's comment), via CANVAS_CSS_PERCENT below.
  // Changing the canvas's own bleed for more/less clipping margin must NOT
  // change how big the disc looks - the two were coupled once (bigger
  // canvas box, same scale, same fixed internal buffer -> bigger apparent
  // disc) and that's what actually needs fixing here, not the disc's own
  // target size.
  const OVERSIZE = 1.06;
  // Keep in sync with .pixel-wheel-canvas's width/height in wheel.css.
  const CANVAS_CSS_PERCENT = 130;
  // Maps native palette.png pixels to canvas-buffer pixels: the disc's
  // measured native radius ends up at OVERSIZE*50% of the wrap's width,
  // expressed in canvas-buffer units via the canvas's own CANVAS_CSS_PERCENT
  // CSS size (not 100%), so resizing that CSS bleed alone never changes the
  // disc's own on-screen size.
  const scale = (size * OVERSIZE * 50) / (CANVAS_CSS_PERCENT * DISC_NATIVE_R);

  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(rotation);
  // Positioned so the hub's own measured center (not the image's corner,
  // and not the disc's own outer-edge center - see above) lands on the
  // rotation origin - drawImage's (dx,dy) is its top-left corner, so that
  // corner sits `center * scale` up-and-left of center.
  ctx.drawImage(
    img,
    -HUB_NATIVE_CX * scale,
    -HUB_NATIVE_CY * scale,
    img.naturalWidth * scale,
    img.naturalHeight * scale
  );
  ctx.restore();
}
