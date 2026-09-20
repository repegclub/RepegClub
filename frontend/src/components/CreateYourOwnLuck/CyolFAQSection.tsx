import { useTranslation } from "react-i18next";
import { FeedbackSection } from "../Shared/FeedbackSection";
import { FAQClassroomPanel } from "../Shared/FAQClassroomPanel";

type FaqItem = { q: string; a: string };

// Same panel as Wheel of Repeg's FAQSection / Weekly Round's
// WeeklyFAQSection, reading its own faqCyol.* content instead. CYOL had no
// FeedbackSection anywhere on its pages before this, so this renders its
// own (same pattern as FAQSection, not WeeklyFAQSection, which relies on
// WeeklyRoundPage already rendering one separately above it).
export function CyolFAQSection() {
  const { t } = useTranslation();
  const items = t("faqCyol.items", { returnObjects: true }) as FaqItem[];

  return (
    <>
      <FeedbackSection />
      <FAQClassroomPanel
        title={t("faqCyol.title")}
        items={items}
        screenPrompt={t("faqCyol.screenPrompt")}
        screenPlaceholder={t("faqCyol.screenPlaceholder")}
        answerLabel={t("faqCyol.screenAnswerLabel")}
      />
    </>
  );
}
