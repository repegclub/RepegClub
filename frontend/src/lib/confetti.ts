// Fire-and-forget confetti burst: each piece is a short-lived DOM node with
// randomized per-instance CSS custom properties that self-removes once its
// CSS animation ends. Deliberately kept as plain DOM manipulation rather
// than React state - the pieces are independent, ephemeral, and never need
// to be read back or diffed, so mirroring the original imperative approach
// is simpler than modeling 46 transient particles in component state.
export function burstConfetti(originEl: HTMLElement): void {
  const colors = ["#5492f7", "#d01e43", "#ffd166", "#eef1f8", "#0b3a9e"];
  const rect = originEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  for (let i = 0; i < 46; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 220;
    piece.style.setProperty("--dx", Math.cos(angle) * dist + "px");
    piece.style.setProperty("--dy", Math.sin(angle) * dist - 60 + "px");
    piece.style.setProperty("--rot", Math.random() * 720 - 360 + "deg");
    piece.style.left = originX + "px";
    piece.style.top = originY + "px";
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = 1.1 + Math.random() * 0.6 + "s";
    document.body.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove());
  }
}
