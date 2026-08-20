import { useCallback, useEffect, useRef, useState } from "react";
import { WalletType, type ConnectedWallet, type WalletController } from "@goblinhunt/cosmes/wallet";
import type { DirectOriginChain } from "../lib/onrampConfig";
import { WC_PROJECT_ID } from "../lib/walletConnectConfig";
import { WALLET_PROVIDERS, type WalletErrorKind, type WalletProviderId } from "../lib/walletProviders";

export type CosmosWalletState =
  | { status: "disconnected" }
  | { status: "connecting"; providerId: WalletProviderId; type: WalletType }
  | { status: "connected"; address: string; wallet: ConnectedWallet; providerId: WalletProviderId }
  | { status: "error"; kind: WalletErrorKind; providerId: WalletProviderId; type: WalletType };

// Separate from the site's main WalletContext/useKeplrWallet on purpose:
// that one is hardwired to this project's usual CHAIN_ID (testnet Terra
// Classic, see chainConfig.ts). The onramp's direct-transfer origins
// (Noble/Cosmos Hub/Osmosis, see onrampConfig.ts's DIRECT_ORIGIN_CHAINS)
// each need their own mainnet connection - no other component needs this,
// so a standalone hook is enough, no shared context. Reconnects from
// scratch whenever `chain` changes (switching tabs in the onramp's origin
// picker) - each (chain, wallet provider) pair is a fully separate
// controller instance, not one juggling everything, since disconnecting one
// shouldn't disconnect another the user already connected on a different
// tab or with a different wallet.
export function useCosmosWallet(chain: DirectOriginChain) {
  const [state, setState] = useState<CosmosWalletState>({ status: "disconnected" });
  const controllersRef = useRef<Map<string, WalletController>>(new Map());
  // Read (not captured) inside onDisconnect/connect()'s post-await checks so
  // they always see the latest render's state, not whatever was current
  // when the closure was created.
  const stateRef = useRef(state);
  stateRef.current = state;

  // DirectTransferCard.tsx remounts the component owning this hook on every
  // tab switch (key={selected.chainId}), so a NEW hook instance always
  // means a genuinely new chain - the old instance's `chain` prop can never
  // change out from under it, only unmount. A connect() already in flight
  // when that unmount happens doesn't get cancelled by React (promises
  // don't know about component lifecycles): without this guard, it would
  // eventually call setState on a hook instance nobody can reach anymore,
  // and - worse - leave a real wallet session (a WalletConnect pairing, an
  // approved extension `enable()`) established with no UI left to manage
  // or disconnect it (found in CodeRabbit review, PR #35; the previous
  // per-render chainIdRef guard here could never actually trigger, since it
  // compared the instance's own chain id against itself).
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-arm on setup, not just reset on cleanup - React Strict Mode
    // double-invokes effects in dev (setup, cleanup, setup again), and
    // without this, mountedRef.current stayed false forever after that
    // first cleanup, so connect() bailed out immediately post-await and
    // the UI hung on "connecting" (found in CodeRabbit review, PR #35).
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function getController(chainId: string, providerId: WalletProviderId): WalletController {
    const key = `${chainId}:${providerId}`;
    let controller = controllersRef.current.get(key);
    if (!controller) {
      const info = WALLET_PROVIDERS.find((p) => p.id === providerId)!;
      controller = info.create(WC_PROJECT_ID);
      // Scoped to the provider that's actually active in state, not just
      // the chain - without this, a controller for a provider the user
      // tried and abandoned (eg. Keplr failed, then Galaxy Station
      // connected successfully) could still fire its own onDisconnect
      // later and wipe out the unrelated, currently-active session (found
      // in CodeRabbit review, PR #35).
      controller.onDisconnect(() => {
        const current = stateRef.current;
        if (current.status !== "disconnected" && current.providerId === providerId) {
          setState({ status: "disconnected" });
        }
      });
      controllersRef.current.set(key, controller);
    }
    return controller;
  }

  const connect = useCallback(
    async (providerId: WalletProviderId, type: WalletType = WalletType.EXTENSION) => {
      const chainId = chain.chainId;
      const controller = getController(chainId, providerId);
      setState({ status: "connecting", providerId, type });
      try {
        const installed = await controller.isInstalled(type);
        if (!mountedRef.current) return;
        if (!installed) {
          setState({ status: "error", kind: "notInstalled", providerId, type });
          return;
        }
        const wallets = await controller.connect(type, [
          { chainId, rpc: chain.rpc, gasPrice: chain.gasPrice, sdkVersion: chain.sdkVersion },
        ]);
        if (!mountedRef.current) {
          // The owning tab was switched away from mid-connect - nothing
          // left to show this session in, so tear it down instead of
          // leaving it dangling.
          controller.disconnect([chainId]);
          return;
        }
        const wallet = wallets.get(chainId);
        if (!wallet) {
          setState({ status: "error", kind: "connectFailed", providerId, type });
          return;
        }
        setState({ status: "connected", address: wallet.address, wallet, providerId });
      } catch {
        if (!mountedRef.current) return;
        setState({ status: "error", kind: "rejected", providerId, type });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chain.chainId]
  );

  const disconnect = useCallback(() => {
    if (state.status !== "disconnected") {
      controllersRef.current.get(`${chain.chainId}:${state.providerId}`)?.disconnect([chain.chainId]);
    }
    setState({ status: "disconnected" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.chainId, state]);

  return { state, connect, disconnect };
}
