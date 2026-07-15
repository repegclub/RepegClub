import { useCallback, useEffect, useRef, useState } from "react";
import { KeplrController, WalletType, type ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { CHAIN_ID, RPC, GAS_PRICE } from "../lib/chainConfig";

export type WalletErrorKind = "notInstalled" | "connectFailed" | "rejected";

export type WalletState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; address: string; wallet: ConnectedWallet }
  | { status: "error"; kind: WalletErrorKind };

// WalletConnect project ID only matters for the mobile/QR connect path; a
// plain browser-extension connection never touches it, so a placeholder is
// fine until real WalletConnect (mobile) support is wired up.
const WC_PROJECT_ID = "placeholder";

export function useKeplrWallet() {
  const [state, setState] = useState<WalletState>({ status: "disconnected" });
  const controllerRef = useRef<KeplrController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new KeplrController(WC_PROJECT_ID);
  }

  const connect = useCallback(async () => {
    const controller = controllerRef.current!;
    setState({ status: "connecting" });
    try {
      const installed = await controller.isInstalled(WalletType.EXTENSION);
      if (!installed) {
        setState({ status: "error", kind: "notInstalled" });
        return;
      }
      const wallets = await controller.connect(WalletType.EXTENSION, [
        { chainId: CHAIN_ID, rpc: RPC, gasPrice: GAS_PRICE, sdkVersion: "sdk53" },
      ]);
      const wallet = wallets.get(CHAIN_ID);
      if (!wallet) {
        setState({ status: "error", kind: "connectFailed" });
        return;
      }
      setState({ status: "connected", address: wallet.address, wallet });
    } catch {
      setState({ status: "error", kind: "rejected" });
    }
  }, []);

  const disconnect = useCallback(() => {
    controllerRef.current?.disconnect([CHAIN_ID]);
    setState({ status: "disconnected" });
  }, []);

  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = controller.onDisconnect(() => {
      setState({ status: "disconnected" });
    });
    return unsubscribe;
  }, []);

  return { state, connect, disconnect };
}
