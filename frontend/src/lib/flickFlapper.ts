export function flickFlapper(pointer: HTMLElement): void {
  pointer.getAnimations().forEach((a) => a.cancel());
  pointer.animate(
    [
      { transform: "translateX(-50%) rotate(0deg)" },
      { transform: "translateX(-50%) rotate(-25deg)", offset: 0.25 },
      { transform: "translateX(-50%) rotate(9deg)", offset: 0.55 },
      { transform: "translateX(-50%) rotate(-3deg)", offset: 0.8 },
      { transform: "translateX(-50%) rotate(0deg)" },
    ],
    { duration: 240, easing: "ease-out" }
  );
}
