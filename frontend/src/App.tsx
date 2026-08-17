import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WheelOfRepeg } from "./components/Wheel/WheelOfRepeg";
import { WeeklyRoundPage } from "./components/Weekly/WeeklyRoundPage";
import { CreateYourOwnLuckPage } from "./components/CreateYourOwnLuck/CreateYourOwnLuckPage";
import { RaffleDetailPage } from "./components/CreateYourOwnLuck/RaffleDetailPage";
import { SocialLinks } from "./components/Shared/SocialLinks";
import { WalletProvider } from "./contexts/WalletContext";

// Lazy, not a static import like the other routes: @skip-go/widget pulls in
// several MB of wallet-connect/EVM dependencies that only this one page
// needs - a static import would ship that weight to every visitor on every
// route, not just people who open /onramp.
const OnrampPage = lazy(() => import("./components/Onramp/OnrampPage").then((m) => ({ default: m.OnrampPage })));

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
          <Route
            path="/onramp"
            element={
              <Suspense fallback={null}>
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
