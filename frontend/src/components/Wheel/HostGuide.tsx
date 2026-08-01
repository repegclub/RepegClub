type BubbleType = "rectangulo" | "horizontal" | "alarma" | "nube";

type HostGuideProps = {
  message: string;
  bubbleType?: BubbleType;
};

// Floats over the wheel visual, near the host character already drawn into
// cabinet-wheel-bg.png - no sprite of its own, the host art lives in that
// background image. Shape/color changes with what it's saying: "rectangulo"/
// "horizontal" are pure CSS (a plain border+clip-path leaves the deeper step
// corners with no border color at all - "open" corners - so, same fix as
// .hero-sign, the outline is its own layer behind the fill, both clipped
// with the identical polygon so the gap between them is a uniform ring
// everywhere, tail included); "alarma"/"nube" are fixed-size images with
// spiky/scalloped silhouettes that can't be stretched without distorting -
// used for short lines only, never long paragraphs.
export function HostGuide({ message, bubbleType = "rectangulo" }: HostGuideProps) {
  // "\n" in a message forces a manual line break at an exact word (used by
  // the hostHype lines to guarantee at most 3 words on the first line) -
  // a literal newline in JSX text collapses to a space otherwise, so it
  // has to be split and rejoined with real <br/> elements.
  const messageLines = message.split("\n");
  return (
    <div className="host-guide-bubble-wrap">
      <div className={`host-guide-bubble-outline host-guide-bubble-outline-${bubbleType}`}>
        <div className={`host-guide-bubble host-guide-bubble-${bubbleType}`}>
          <p>
            {messageLines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </p>
        </div>
      </div>
      {/* Baking the tail into the same clip-path polygon as the box turned
          out unreliable (verified via the browser's own Computed clip-path -
          it matched the source exactly, yet no visible tail rendered, at 2
          different sizes) - 2 small plain bordered squares instead, no
          clip-path/polygon math involved at all for these, just a normal
          CSS border, so there's nothing subtle left to get wrong. */}
      {bubbleType === "horizontal" && (
        <>
          <div className="host-guide-bubble-tail host-guide-bubble-tail-1" />
          <div className="host-guide-bubble-tail host-guide-bubble-tail-2" />
        </>
      )}
    </div>
  );
}
