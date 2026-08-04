import { useTranslation } from "react-i18next";
import { FAQClassroomPanel } from "../Shared/FAQClassroomPanel";

type FaqItem = { q: string; a: string };

// Same panel as Wheel of Repeg's FAQSection, reading its own faqWeekly.*
// content instead - Weekly Round already renders its own FeedbackSection
// separately above this, so unlike FAQSection this doesn't render one too.
export function WeeklyFAQSection() {
  const { t } = useTranslation();
  const items = t("faqWeekly.items", { returnObjects: true }) as FaqItem[];

  return (
    <FAQClassroomPanel
      title={t("faqWeekly.title")}
      items={items}
      screenPrompt={t("faqWeekly.screenPrompt")}
      screenPlaceholder={t("faqWeekly.screenPlaceholder")}
    />
  );
}
