import { useTranslation } from "react-i18next";
import { FeedbackSection } from "../Shared/FeedbackSection";

type FaqItem = { q: string; a: string };

export function FAQSection() {
  const { t } = useTranslation();
  const items = t("faq.items", { returnObjects: true }) as FaqItem[];

  return (
    <section className="faq-section">
      <FeedbackSection />
      <h2 className="faq-title">{t("faq.title")}</h2>
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
