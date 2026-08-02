import { useTranslation } from "react-i18next";

type FaqItem = { q: string; a: string };

// Same markup/classes as Wheel of Repeg's FAQSection (reused as-is from
// wheel.css), reading its own faqWeekly.* content instead - Weekly Round
// already renders its own FeedbackSection separately above this, so unlike
// FAQSection this doesn't render one too.
export function WeeklyFAQSection() {
  const { t } = useTranslation();
  const items = t("faqWeekly.items", { returnObjects: true }) as FaqItem[];

  return (
    <section className="faq-section">
      <h2 className="faq-title">{t("faqWeekly.title")}</h2>
      {items.map((item) => (
        <div key={item.q} className="faq-item-outline pixel-stepped-corners-sm">
          <details className="faq-item pixel-stepped-corners-sm">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        </div>
      ))}
    </section>
  );
}
