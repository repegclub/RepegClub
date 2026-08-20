import { useCallback, useRef, useState } from "react";
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
      if (!installed) {
        setState({ status: "error", kind: "notInstalled", providerId, type });
        return;
      }
      const wallets = await controller.connect(type, [
        { chainId: CHAIN_ID, rpc: RPC, gasPrice: GAS_PRICE, sdkVersion: "sdk53" },
      ]);
      const wallet = wallets.get(CHAIN_ID);
      if (!wallet) {
        setState({ status: "error", kind: "connectFailed", providerId, type });
        return;
      }
      setState({ status: "connected", address: wallet.address, wallet, providerId });
    } catch {
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
