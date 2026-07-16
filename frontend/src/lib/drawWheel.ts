import type { Arc } from "./wheelData";
import { shade } from "./wheelPhysics";

export type WheelStyle = "classic" | "chrome";

// Preloaded once and reused for every draw call/frame - drawWheel itself
// stays synchronous, falling back to the old flat gradient until the image
// has actually loaded. Callers waiting on it get notified once so they can
// redraw - otherwise a wheel drawn before the image finishes loading (the
// common case, since it's not needed for the very first paint) would just
// never pick it up until something else happens to trigger a redraw.
let obsidianImg: HTMLImageElement | null = null;
let obsidianLoaded = false;
const obsidianWaiters: Array<() => void> = [];
function getObsidianImage(onLoad?: () => void): HTMLImageElement | null {
  if (!obsidianImg) {
    obsidianImg = new Image();
    obsidianImg.src = "/wheel-obsidian.jpg";
    obsidianImg.onload = () => {
      obsidianLoaded = true;
      obsidianWaiters.splice(0).forEach((cb) => cb());
    };
  }
  if (!obsidianLoaded && onLoad) obsidianWaiters.push(onLoad);
  return obsidianLoaded ? obsidianImg : null;
}

// Draws `img` (or a sub-rectangle crop of it) centered on (cx, cy) scaled
// to cover a boxSize x boxSize square (same idea as CSS background-size:
// cover, with an optional source crop instead of always using the whole
// image).
function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  boxSize: number,
  crop?: { sx: number; sy: number; sw: number; sh: number }
) {
  const sx = crop?.sx ?? 0;
  const sy = crop?.sy ?? 0;
  const sw = crop?.sw ?? img.naturalWidth;
  const sh = crop?.sh ?? img.naturalHeight;
  const scale = Math.max(boxSize / sw, boxSize / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(img, sx, sy, sw, sh, cx - w / 2, cy - h / 2, w, h);
}

// Default 340px canvas (Wheel of Repeg). Weekly Round renders bigger (see
// WeeklyWheelCard) - every measurement below is derived from `size` so both
// scale together instead of the bigger canvas just stretching blurry pixels.
export function drawWheel(
  ctx: CanvasRenderingContext2D,
  rotation: number,
  arcs: Arc[],
  size = 340,
  style: WheelStyle = "classic"
) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.485;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.translate(-cx, -cy);

  arcs.forEach((a) => {
    const mid = (a.start + a.end) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a.start, a.end);
    ctx.closePath();

    if (style === "chrome") {
      // Black-glass look: the real photo texture drawn plainly (once
      // loaded) as the segment's actual material, identically positioned
      // for every wedge so adjacent segments show continuous parts of one
      // shared slab instead of looking like separate tinted fragments. The
      // photo's own reflections already read as "glossy" - no synthetic
      // sheen gradient painted on top, which only washed the real texture
      // out. The sheen is kept for the brief fallback before the photo has
      // loaded, when there's nothing else to suggest shine.
      ctx.save();
      ctx.clip();

      const obsidian = getObsidianImage(() => drawWheel(ctx, rotation, arcs, size, style));
      if (obsidian) {
        // The lower-right region of the source photo has the darker,
        // least shiny tones - use just that instead of the whole frame.
        drawCoverImage(ctx, obsidian, cx, cy, r * 2, {
          sx: obsidian.naturalWidth * 0.55,
          sy: obsidian.naturalHeight * 0.32,
          sw: obsidian.naturalWidth * 0.39,
          sh: obsidian.naturalHeight * 0.58,
        });
        // Colored glass over the stone: a translucent per-entrant tint so
        // each wallet's segment is identifiable at a glance, without
        // covering the texture underneath. Placeholder slots use a near-
        // black color that's invisible against the dark stone by design -
        // only real entrants (bright palette colors) show a visible tint.
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = a.color;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
      } else {
        const base = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
        base.addColorStop(0, shade(a.color, 15));
        base.addColorStop(0.7, shade(a.color, -10));
        base.addColorStop(1, shade(a.color, -35));
        ctx.fillStyle = base;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

        const bandX = cx + Math.cos(mid) * r * 0.5;
        const bandY = cy + Math.sin(mid) * r * 0.5;
        const sheen = ctx.createLinearGradient(
          bandX - r * 0.6,
          bandY - r * 0.6,
          bandX + r * 0.6,
          bandY + r * 0.6
        );
        sheen.addColorStop(0, "rgba(255,255,255,0.05)");
        sheen.addColorStop(0.35, "rgba(255,255,255,0.55)");
        sheen.addColorStop(0.5, "rgba(255,255,255,0.08)");
        sheen.addColorStop(0.65, "rgba(0,0,0,0.22)");
        sheen.addColorStop(1, "rgba(255,255,255,0.03)");
        ctx.fillStyle = sheen;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      ctx.restore();
    } else {
      const gloss = ctx.createRadialGradient(cx, cy, size * 0.053, cx, cy, r);
      gloss.addColorStop(0, shade(a.color, 38));
      gloss.addColorStop(0.6, a.color);
      gloss.addColorStop(1, shade(a.color, -28));
      ctx.fillStyle = gloss;
      ctx.fill();
    }

    if (style === "chrome") {
      // Gold divider lines with the same light/dark metallic shine as the
      // rest of the chrome wheel's gold trim, instead of a flat black line.
      const divider = ctx.createLinearGradient(cx, cy, cx + Math.cos(mid) * r, cy + Math.sin(mid) * r);
      divider.addColorStop(0, "#fff4c2");
      divider.addColorStop(0.45, "#ffd166");
      divider.addColorStop(1, "#8a5f12");
      ctx.strokeStyle = divider;
    } else {
      ctx.strokeStyle = "#05060a";
    }
    ctx.lineWidth = size * 0.0059;
    ctx.stroke();

    // Placeholder slots (empty round, no real entrant yet) carry no name -
    // labeling them "0x" would misleadingly suggest a real, ticketless entry.
    if (a.name === "") return;

    const labelR = r * 0.68;
    const lx = cx + Math.cos(mid) * labelR;
    const ly = cy + Math.sin(mid) * labelR;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(mid + Math.PI / 2);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.font = `400 ${Math.round(size * 0.044)}px Bungee, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.tickets + "x", 0, 0);
    ctx.restore();
  });

  // Metal pegs at each segment boundary - what the flapper physically ticks
  // against, like a real prize wheel. Chrome style gets a cooler, brighter
  // peg to match the segments' metallic treatment instead of the warm gold
  // used on the classic wheel.
  const pegOuter = style === "chrome" ? ["#ffffff", "#dfe6f2", "#8f9bb3"] : ["#fdf6e3", "#d8c98a", "#8a7a45"];
  arcs.forEach((a) => {
    const px = cx + Math.cos(a.start) * (r - size * 0.0206);
    const py = cy + Math.sin(a.start) * (r - size * 0.0206);
    const pegR = size * 0.0132;
    const grad = ctx.createRadialGradient(px - pegR / 3, py - pegR / 3, 0, px, py, pegR * 1.1);
    grad.addColorStop(0, pegOuter[0]);
    grad.addColorStop(0.55, pegOuter[1]);
    grad.addColorStop(1, pegOuter[2]);
    ctx.beginPath();
    ctx.arc(px, py, pegR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "#05060a";
    ctx.lineWidth = size * 0.0029;
    ctx.stroke();
  });

  ctx.restore();
}
