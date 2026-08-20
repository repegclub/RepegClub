import { useCallback, useRef, useState } from "react";
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
  // Always holds the currently-selected chain id, read (not captured) inside
  // connect()'s post-await checks - `chain` itself is fine to read normally
  // everywhere else, but a value closed over at call time would still be the
  // OLD chain if the user switches tabs while a wallet popup is pending,
  // which is exactly the race this guards against.
  const chainIdRef = useRef(chain.chainId);
  chainIdRef.current = chain.chainId;

  function getController(chainId: string, providerId: WalletProviderId): WalletController {
    const key = `${chainId}:${providerId}`;
    let controller = controllersRef.current.get(key);
    if (!controller) {
      const info = WALLET_PROVIDERS.find((p) => p.id === providerId)!;
      controller = info.create(WC_PROJECT_ID);
      controller.onDisconnect(() => {
        if (chainIdRef.current === chainId) setState({ status: "disconnected" });
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
        if (chainIdRef.current !== chainId) return;
        if (!installed) {
          setState({ status: "error", kind: "notInstalled", providerId, type });
          return;
        }
        const wallets = await controller.connect(type, [
          { chainId, rpc: chain.rpc, gasPrice: chain.gasPrice, sdkVersion: chain.sdkVersion },
        ]);
        if (chainIdRef.current !== chainId) return;
        const wallet = wallets.get(chainId);
        if (!wallet) {
          setState({ status: "error", kind: "connectFailed", providerId, type });
          return;
        }
        setState({ status: "connected", address: wallet.address, wallet, providerId });
      } catch {
        if (chainIdRef.current !== chainId) return;
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
