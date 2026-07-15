import { createContext, useContext, type ReactNode } from "react";
import { useKeplrWallet, type WalletState } from "../hooks/useKeplrWallet";

type WalletContextValue = {
  state: WalletState;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useKeplrWallet();
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
