import { createPixelWheelDraw } from "./drawPixelWheel";

// Weekly Round's own jeweled/crown wheel - same rotating-disc + static-frame
// split as Wheel of Repeg's pixel wheel (see drawPixelWheel.ts), just a
// second art set and its own measured constants. palette.png (512x512,
// downscaled from a 1024x1024 source) is already close to a true circle
// (measured boundary-to-center distance only varies ~255.5-256px) and its
// crown hub sits almost exactly on the disc's own geometric center - no
// hub/disc-center split worth calling out separately here, unlike Wheel of
// Repeg's palette.png.
export const drawWeeklyPixelWheel = createPixelWheelDraw({
  imageSrc: "/weekly-pixel/palette.png",
  hubNativeCx: 256.55,
  hubNativeCy: 256.4,
  discNativeR: 255.65,
  // First-pass computed value (frame's own hole radius, ~43.1% of the
  // frame's native width, plus a ~6% margin so the disc's edge tucks under
  // the ring rather than exactly matching it - same margin Wheel of Repeg
  // settled on after visual tuning) - re-check against the frame overlay on
  // localhost and nudge if a gap or seam shows at the rim.
  targetRadiusPercent: 45.7,
  canvasCssPercent: 130,
});
