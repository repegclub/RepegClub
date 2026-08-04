import { useEffect, useRef, useState } from "react";

type FaqItem = { q: string; a: string };

// Replaces the old <details> accordion list: instead of each question
// expanding in place, tapping one prints its answer onto the professor's
// classroom screen above the list (public/characters/faq-classroom.png).
// .faq-screen's inset percentages in wheel.css are measured against that
// exact image - re-measure them if it's ever re-cropped.
export function FAQClassroomPanel({
  title,
  items,
  screenPrompt,
  screenPlaceholder,
}: {
  title: string;
  items: FaqItem[];
  screenPrompt: string;
  screenPlaceholder: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected !== null ? items[selected] : null;
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [selected]);

  return (
    <section className="faq-section">
      <h2 className="faq-title">{title}</h2>
      <div className="faq-classroom-outline pixel-stepped-corners">
      <div className="faq-classroom-highlight pixel-stepped-corners">
      <div className="faq-classroom pixel-stepped-corners">
        <img src="/characters/faq-classroom.png" alt="" />
        <img src="/brand/isotipo-pixel-art.png" alt="" className="faq-classroom-logo" />
        <div className="faq-screen">
          <p className="faq-screen-title">{active ? active.q : screenPrompt}</p>
          <div className="faq-screen-body" ref={bodyRef}>
            <p>{active ? active.a : screenPlaceholder}</p>
          </div>
        </div>
      </div>
      </div>
      </div>
      <div className="faq-question-list">
        {items.map((item, i) => (
          <button
            key={item.q}
            type="button"
            className={
              i === selected ? "faq-question pixel-stepped-corners-sm faq-question-active" : "faq-question pixel-stepped-corners-sm"
            }
            onClick={() => setSelected(i)}
          >
            {item.q}
          </button>
        ))}
      </div>
    </section>
  );
}
