import { useCallback, useEffect, useRef, useState } from "react";
import { WalletType, type ConnectedWallet, type WalletController } from "@goblinhunt/cosmes/wallet";
import { CHAIN_ID, RPC, GAS_PRICE } from "../lib/chainConfig";
import { WC_PROJECT_ID } from "../lib/walletConnectConfig";
import { WALLET_PROVIDERS, type WalletErrorKind, type WalletProviderId } from "../lib/walletProviders";

export type { WalletErrorKind };

export type WalletState =
  | { status: "disconnected" }
  | { status: "connecting"; providerId: WalletProviderId; type: WalletType }
  | { status: "connected"; address: string; wallet: ConnectedWallet; providerId: WalletProviderId }
  | { status: "error"; kind: WalletErrorKind; providerId: WalletProviderId; type: WalletType };

export function useKeplrWallet() {
  const [state, setState] = useState<WalletState>({ status: "disconnected" });
  // One controller per provider, created lazily on first connect attempt -
  // switching providers never tears down the other's controller, so a user
  // who tried Keplr then switched to Galaxy Station could reconnect to
  // either without losing state. The same controller handles both the
  // extension and WalletConnect (mobile/QR) paths internally, so this map
  // isn't keyed by connection type too.
  const controllersRef = useRef<Map<WalletProviderId, WalletController>>(new Map());
  // Read (not captured) inside onDisconnect below, so it always sees the
  // latest render's state rather than whatever was current when the
  // controller (and its callback closure) was first created.
  const stateRef = useRef(state);
  stateRef.current = state;
  // WalletProvider (WalletContext.tsx) wraps the whole app above <Routes>,
  // so this hook instance only unmounts if the entire page unloads - a
  // lower-probability window than the onramp's per-tab remounts, but the
  // same race is possible in principle: connect() awaiting isInstalled()/
  // connect() with no guard could still call setState after unmount, and a
  // connect() that resolves after that point would leave a live wallet
  // session with nothing left to manage or disconnect it (found in
  // CodeRabbit review, PR #35; same fix already applied to
  // useCosmosWallet.ts, re-armed on setup here too - a cleanup-only reset
  // stays false forever after React Strict Mode's dev-only double-invoke).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function getController(providerId: WalletProviderId): WalletController {
    let controller = controllersRef.current.get(providerId);
    if (!controller) {
      const info = WALLET_PROVIDERS.find((p) => p.id === providerId)!;
      controller = info.create(WC_PROJECT_ID);
      // Scoped to the provider that's actually active in state - without
      // this, a controller for a provider the user tried and abandoned (eg.
      // Keplr failed, then Galaxy Station connected successfully) could
      // still fire its own onDisconnect later and wipe out the unrelated,
      // currently-active session (found in CodeRabbit review, PR #35).
      controller.onDisconnect(() => {
        if (!mountedRef.current) return;
        const current = stateRef.current;
        if (current.status !== "disconnected" && current.providerId === providerId) {
          setState({ status: "disconnected" });
        }
      });
      controllersRef.current.set(providerId, controller);
    }
    return controller;
  }

  const connect = useCallback(async (providerId: WalletProviderId, type: WalletType = WalletType.EXTENSION) => {
    const controller = getController(providerId);
    setState({ status: "connecting", providerId, type });
    try {
      const installed = await controller.isInstalled(type);
      if (!mountedRef.current) return;
      if (!installed) {
        setState({ status: "error", kind: "notInstalled", providerId, type });
        return;
      }
      const wallets = await controller.connect(type, [
        { chainId: CHAIN_ID, rpc: RPC, gasPrice: GAS_PRICE, sdkVersion: "sdk53" },
      ]);
      if (!mountedRef.current) {
        // The page unloaded mid-connect - nothing left to show this
        // session in, so tear it down instead of leaving it dangling.
        controller.disconnect([CHAIN_ID]);
        return;
      }
      const wallet = wallets.get(CHAIN_ID);
      if (!wallet) {
        setState({ status: "error", kind: "connectFailed", providerId, type });
        return;
      }
      setState({ status: "connected", address: wallet.address, wallet, providerId });
    } catch {
      if (!mountedRef.current) return;
      setState({ status: "error", kind: "rejected", providerId, type });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = useCallback(() => {
    if (state.status !== "disconnected") {
      controllersRef.current.get(state.providerId)?.disconnect([CHAIN_ID]);
    }
    setState({ status: "disconnected" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return { state, connect, disconnect };
}
