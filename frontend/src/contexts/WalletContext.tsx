import { createContext, useContext, type ReactNode } from "react";
import type { WalletType } from "@goblinhunt/cosmes/wallet";
import { useKeplrWallet, type WalletState } from "../hooks/useKeplrWallet";
import type { WalletProviderId } from "../lib/walletProviders";

type WalletContextValue = {
  state: WalletState;
  connect: (providerId: WalletProviderId, type?: WalletType) => Promise<void>;
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
