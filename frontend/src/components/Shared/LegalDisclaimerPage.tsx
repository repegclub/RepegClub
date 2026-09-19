import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import "../../styles/wheel.css";

// Standalone page, not wrapped in GameNav - unlike every other route, this
// one doesn't need wallet-connect/network UI, and it's reached either from
// the jurisdiction gate modal (opens in a new tab, see JurisdictionGateModal)
// or the footer icon in SocialLinks.tsx, both from any page. See "Repeg Club
// - Investigación legal pre-anuncio (geobloqueo, disclaimer, precedentes)
// (2026-09-10)" in the project's Obsidian vault for the research and
// precedents this text is based on.
export function LegalDisclaimerPage() {
  const { t } = useTranslation();
  const sections = t("legal.sections", { returnObjects: true });
  const sectionList = Array.isArray(sections)
    ? sections.filter(
        (s): s is { heading: string; body: string } =>
          typeof s === "object" && s !== null && "heading" in s && "body" in s
      )
    : [];

  return (
    <main className="legal-page">
      <Link to="/" className="legal-back-link">
        {t("legal.backLink")}
      </Link>
      <h1 className="legal-title">{t("legal.title")}</h1>
      <p className="legal-intro">{t("legal.intro")}</p>
      {sectionList.map((section) => (
        <section key={section.heading} className="legal-section">
          <h2 className="legal-section-heading">{section.heading}</h2>
          <p className="legal-section-body">{section.body}</p>
        </section>
      ))}
    </main>
  );
}
