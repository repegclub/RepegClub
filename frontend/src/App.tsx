import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WheelOfRepeg } from "./components/Wheel/WheelOfRepeg";
import { WeeklyRoundPage } from "./components/Weekly/WeeklyRoundPage";
import { CreateYourOwnLuckPage } from "./components/CreateYourOwnLuck/CreateYourOwnLuckPage";
import { CreatorToolsPage } from "./components/CreateYourOwnLuck/CreatorToolsPage";
import { RaffleDetailPage } from "./components/CreateYourOwnLuck/RaffleDetailPage";
import { SocialLinks } from "./components/Shared/SocialLinks";
import { WalletProvider } from "./contexts/WalletContext";

// Lazy, not a static import like the other routes: @skip-go/widget pulls in
// several MB of wallet-connect/EVM dependencies that only this one page
// needs - a static import would ship that weight to every visitor on every
// route, not just people who open /onramp.
const OnrampPage = lazy(() => import("./components/Onramp/OnrampPage").then((m) => ({ default: m.OnrampPage })));

// Inline-styled on purpose, not a shared page class - wheel.css/onramp.css
// are both imported inside OnrampPage.tsx itself, so neither is loaded yet
// while this fallback is showing (confirmed: nothing global sets a
// background/color, see index.css). A blank page while the ~6MB chunk
// downloads used to leave visitors with no signal anything was happening
// (found in review, 2026-08-17).
function OnrampLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#070911",
        color: "#f1f4fb",
        fontFamily: "vt323, -apple-system, blinkmacsystemfont, 'Segoe UI', sans-serif",
        fontSize: "1.2rem",
      }}
    >
      {t("onramp.loading")}
    </div>
  );
}

// Wheel of Repeg keeps living at "/" (unchanged) rather than moving to its
// own path - that move is already anticipated for whenever a landing page
// gets built (see project notes), not needed just to add this second route.
function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<WheelOfRepeg />} />
          <Route path="/weekly-round" element={<WeeklyRoundPage />} />
          <Route path="/create-your-own-luck" element={<CreateYourOwnLuckPage />} />
          <Route path="/create-your-own-luck/:address" element={<RaffleDetailPage />} />
          <Route path="/creators" element={<CreatorToolsPage />} />
          <Route
            path="/onramp"
            element={
              <Suspense fallback={<OnrampLoading />}>
                <OnrampPage />
              </Suspense>
            }
          />
        </Routes>
        <SocialLinks />
      </BrowserRouter>
    </WalletProvider>
  );
}

export default App;
