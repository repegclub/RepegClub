import { useTranslation } from "react-i18next";

type FaqItem = { q: string; a: string };

export function FAQSection() {
  const { t } = useTranslation();
  const items = t("faq.items", { returnObjects: true }) as FaqItem[];

  return (
    <section className="faq-section">
      <h2 className="faq-title">{t("faq.title")}</h2>
      {items.map((item) => (
        <details key={item.q} className="faq-item">
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </section>
  );
}
