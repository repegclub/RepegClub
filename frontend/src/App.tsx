import { WheelOfRepeg } from "./components/Wheel/WheelOfRepeg";
import { WalletProvider } from "./contexts/WalletContext";

function App() {
  return (
    <WalletProvider>
      <WheelOfRepeg />
    </WalletProvider>
  );
}

export default App;
