import { useTranslation } from "react-i18next";
import { FeedbackButton } from "../Wheel/FeedbackButton";

// Was in the sticky wallet-bar on every page - on narrow cards that bar
// already has Games/Creators plus the wallet controls competing for room,
// and Feedback isn't something a player needs mid-game, so it moved down
// here instead. Wheel of Repeg renders this right above its FAQ (see
// FAQSection.tsx); Weekly Round has no FAQ section yet, so it renders this
// alone near the end of the page.
export function FeedbackSection() {
  const { t } = useTranslation();
  return (
    <div className="feedback-section">
      <p className="feedback-section-prompt">{t("faq.feedbackPrompt")}</p>
      <FeedbackButton />
    </div>
  );
}
