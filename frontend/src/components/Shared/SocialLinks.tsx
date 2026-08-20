import { useTranslation } from "react-i18next";
import { TreasuryPanel } from "./TreasuryPanel";

// Explicit filename, not "/whitepaper/" - Vite's dev-server SPA history
// fallback intercepts a bare directory path (no route matches it, so it
// serves the React app's own index.html instead of the static file), and
// relying on a host's directory-index behavior in production would make
// dev and prod diverge for no reason.
const WHITEPAPER_URL = "/whitepaper/index.html";
const TELEGRAM_URL = "https://t.me/+ifW-eoWfLiY4OTAx";
const GITHUB_URL = "https://github.com/repegclub/RepegClub";

// Rendered once in App.tsx, outside <Routes>, so it floats on every page
// (current and future) without each page having to remember to include it.
// A website link doubles as the actual way in for anyone whose own Telegram
// group blocks posting t.me invite links but allows regular URLs. The
// whitepaper link is a plain full-page navigation (not a React Router
// route) - it's a static, self-contained HTML file under public/, same
// reasoning as the site's other standalone static pages.
export function SocialLinks() {
  const { t } = useTranslation();
  return (
    <div className="social-links-bar">
      <TreasuryPanel />
      <a
        href={WHITEPAPER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="social-links-icon"
        aria-label={t("socialLinks.whitepaper")}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM7 12h10v1.5H7V12Zm0 3.5h10V17H7v-1.5Zm0-7h5V10H7V8.5Z" />
        </svg>
        <span className="social-links-tooltip" aria-hidden="true">{t("socialLinks.whitepaper")}</span>
      </a>
      <a
        href={TELEGRAM_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="social-links-icon"
        aria-label={t("socialLinks.telegram")}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M21.9 3.5 2.6 11c-.9.35-.9 1.63.01 1.96l4.55 1.6 1.76 5.66c.24.77 1.22.98 1.77.38l2.44-2.66 4.68 3.46c.7.52 1.7.14 1.9-.71l3.35-14.6c.23-.99-.72-1.85-1.66-1.59Zm-3.1 3.36-8.6 7.85-.4 3.02-1.36-4.38 9.7-6.9c.24-.17.5.13.29.32Z" />
        </svg>
        <span className="social-links-tooltip" aria-hidden="true">{t("socialLinks.telegram")}</span>
      </a>
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="social-links-icon"
        aria-label={t("socialLinks.repo")}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M12 2C6.48 2 2 6.58 2 12.19c0 4.49 2.87 8.3 6.84 9.65.5.1.68-.22.68-.49 0-.24-.01-1.03-.01-1.87-2.78.61-3.37-1.19-3.37-1.19-.45-1.17-1.11-1.48-1.11-1.48-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.13-4.56-5.03 0-1.11.39-2.02 1.03-2.73-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.04a9.4 9.4 0 0 1 5.01 0c1.9-1.31 2.75-1.04 2.75-1.04.55 1.42.2 2.47.1 2.73.64.71 1.03 1.62 1.03 2.73 0 3.91-2.35 4.77-4.58 5.02.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.19C22 6.58 17.52 2 12 2Z" />
        </svg>
        <span className="social-links-tooltip" aria-hidden="true">{t("socialLinks.repo")}</span>
      </a>
    </div>
  );
}
