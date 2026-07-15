import type { Arc } from "./wheelData";
import { shade } from "./wheelPhysics";

const CX = 170;
const CY = 170;
const R = 165;

export function drawWheel(ctx: CanvasRenderingContext2D, rotation: number, arcs: Arc[]) {
  ctx.clearRect(0, 0, 340, 340);
  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(rotation);
  ctx.translate(-CX, -CY);

  arcs.forEach((a) => {
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, a.start, a.end);
    ctx.closePath();
    const gloss = ctx.createRadialGradient(CX, CY, 18, CX, CY, R);
    gloss.addColorStop(0, shade(a.color, 38));
    gloss.addColorStop(0.6, a.color);
    gloss.addColorStop(1, shade(a.color, -28));
    ctx.fillStyle = gloss;
    ctx.fill();
    ctx.strokeStyle = "#05060a";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Placeholder slots (empty round, no real entrant yet) carry no name -
    // labeling them "0x" would misleadingly suggest a real, ticketless entry.
    if (a.name === "") return;

    const mid = (a.start + a.end) / 2;
    const labelR = R * 0.68;
    const lx = CX + Math.cos(mid) * labelR;
    const ly = CY + Math.sin(mid) * labelR;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(mid + Math.PI / 2);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.font = "400 15px Bungee, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.tickets + "x", 0, 0);
    ctx.restore();
  });

  // Metal pegs at each segment boundary - what the flapper physically ticks
  // against, like a real prize wheel.
  arcs.forEach((a) => {
    const px = CX + Math.cos(a.start) * (R - 7);
    const py = CY + Math.sin(a.start) * (R - 7);
    const grad = ctx.createRadialGradient(px - 1.5, py - 1.5, 0, px, py, 5);
    grad.addColorStop(0, "#fdf6e3");
    grad.addColorStop(0.55, "#d8c98a");
    grad.addColorStop(1, "#8a7a45");
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "#05060a";
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  ctx.restore();
}
