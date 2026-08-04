import { useTranslation } from "react-i18next";
import { FeedbackSection } from "../Shared/FeedbackSection";
import { FAQClassroomPanel } from "../Shared/FAQClassroomPanel";

type FaqItem = { q: string; a: string };

export function FAQSection() {
  const { t } = useTranslation();
  const items = t("faq.items", { returnObjects: true }) as FaqItem[];

  return (
    <>
      <FeedbackSection />
      <FAQClassroomPanel
        title={t("faq.title")}
        items={items}
        screenPrompt={t("faq.screenPrompt")}
        screenPlaceholder={t("faq.screenPlaceholder")}
      />
    </>
  );
}
