import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WheelOfRepeg } from "./components/Wheel/WheelOfRepeg";
import { WeeklyRoundPage } from "./components/Weekly/WeeklyRoundPage";
import { WalletProvider } from "./contexts/WalletContext";

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
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}

export default App;
