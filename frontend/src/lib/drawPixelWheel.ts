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
// vs. outer rim only), which is what actually lets targetRadiusPercent below
// give real forgiveness instead of just trading a gap at the rim for a gap
// around the hub.
//
// Factored into a config-driven factory so Weekly Round's own jeweled wheel
// (different art, different native measurements) can reuse this exact draw
// logic instead of a second hand-copied ~90-line implementation - see
// drawWeeklyPixelWheel.ts. Each instance keeps its own image-load state
// (module-level closure), same caching behavior the original single-wheel
// version had.
export type PixelWheelConfig = {
  imageSrc: string;
  // Rotation origin: the disc's own hub center in the source image's native
  // px, NOT the disc's outer-edge center - see the per-instance measurement
  // comments below for why that distinction matters.
  hubNativeCx: number;
  hubNativeCy: number;
  // The disc's measured native radius (boundary-to-center distance).
  discNativeR: number;
  // The disc's target on-screen radius, as a percentage of .pixel-wheel-wrap
  // width - deliberately independent of .pixel-wheel-canvas's own CSS bleed
  // (canvasCssPercent), via the scale formula below. Slightly larger than
  // the static frame's own ring-hole radius (see PixelWheelCanvas's frame
  // overlay) so the disc's edge sits comfortably under the ring instead of
  // exactly matching it.
  targetRadiusPercent: number;
  // Keep in sync with .pixel-wheel-canvas's width/height in wheel.css.
  canvasCssPercent: number;
};

export function createPixelWheelDraw(config: PixelWheelConfig) {
  let img: HTMLImageElement | null = null;
  let loaded = false;
  let failed = false;
  const waiters: Array<() => void> = [];

  function getImage(onLoad?: () => void): HTMLImageElement | null {
    if (failed) return null;
    if (!img) {
      img = new Image();
      img.src = config.imageSrc;
      img.onload = () => {
        loaded = true;
        waiters.splice(0).forEach((cb) => cb());
      };
      // Draining `waiters` here isn't enough on its own - `img` stays
      // non-null and `loaded` stays false forever after a failed load (this
      // Image object's onload/onerror never fire again), so every future
      // draw() call would otherwise keep pushing a new callback onto
      // `waiters` below with nothing left to ever drain it - an unbounded
      // leak, since draw() runs on every animation frame while spinning
      // (CodeRabbit finding, confirmed). `failed` short-circuits that.
      img.onerror = () => {
        failed = true;
        waiters.splice(0);
      };
    }
    if (!loaded && onLoad) waiters.push(onLoad);
    return loaded ? img : null;
  }

  // Second param matches drawWheel's (ctx, rotation, arcs, size) shape so it
  // can be passed as a drop-in `draw` override to useWheelSpin - arcs is
  // intentionally unused, since this wheel's layout never depends on them.
  return function draw(ctx: CanvasRenderingContext2D, rotation: number, _arcs?: unknown, size = 340) {
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;

    const image = getImage(() => draw(ctx, rotation, _arcs, size));
    if (!image) return;

    // Maps native image px to canvas-buffer px: the disc's measured native
    // radius ends up at targetRadiusPercent of the wrap's width, expressed
    // in canvas-buffer units via canvasCssPercent (not 100%), so resizing
    // the canvas's own CSS bleed alone never changes the disc's own
    // on-screen size.
    const scale = (size * config.targetRadiusPercent) / (config.canvasCssPercent * config.discNativeR);

    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(rotation);
    // Positioned so the hub's own measured center (not the image's corner,
    // and not the disc's own outer-edge center) lands on the rotation
    // origin - drawImage's (dx,dy) is its top-left corner, so that corner
    // sits `center * scale` up-and-left of center.
    ctx.drawImage(
      image,
      -config.hubNativeCx * scale,
      -config.hubNativeCy * scale,
      image.naturalWidth * scale,
      image.naturalHeight * scale
    );
    ctx.restore();
  };
}

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
//
// targetRadiusPercent=53 (was OVERSIZE=1.06, i.e. 1.06*50) - see the
// PixelWheelCanvas/.pixel-wheel-frame comment in wheel.css for how this was
// tuned against the frame's own measured ring-hole radius.
export const drawPixelWheel = createPixelWheelDraw({
  imageSrc: "/wheel-pixel/palette.png",
  hubNativeCx: 199.9,
  hubNativeCy: 196.21,
  discNativeR: 197.85,
  targetRadiusPercent: 53,
  canvasCssPercent: 130,
});
