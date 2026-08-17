import { useCallback, useEffect, useRef, useState } from "react";
import { KeplrController, WalletType, type ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import type { DirectOriginChain } from "../lib/onrampConfig";
import type { WalletErrorKind } from "./useKeplrWallet";

export type CosmosWalletState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; address: string; wallet: ConnectedWallet }
  | { status: "error"; kind: WalletErrorKind };

// Separate from the site's main WalletContext/useKeplrWallet on purpose:
// that one is hardwired to this project's usual CHAIN_ID (testnet Terra
// Classic, see chainConfig.ts). The onramp's direct-transfer origins
// (Noble/Cosmos Hub/Osmosis, see onrampConfig.ts's DIRECT_ORIGIN_CHAINS)
// each need their own mainnet connection - no other component needs this,
// so a standalone hook is enough, no shared context. Reconnects from
// scratch whenever `chain` changes (switching tabs in the onramp's origin
// picker) - each chain is a fully separate KeplrController instance, not a
// single one juggling multiple chains, since disconnecting one shouldn't
// disconnect another the user already connected on a different tab.
export function useCosmosWallet(chain: DirectOriginChain) {
  const [state, setState] = useState<CosmosWalletState>({ status: "disconnected" });
  const controllersRef = useRef<Map<string, KeplrController>>(new Map());

  function getController(chainId: string): KeplrController {
    let controller = controllersRef.current.get(chainId);
    if (!controller) {
      controller = new KeplrController("placeholder");
      controllersRef.current.set(chainId, controller);
    }
    return controller;
  }

  const connect = useCallback(async () => {
    const controller = getController(chain.chainId);
    setState({ status: "connecting" });
    try {
      const installed = await controller.isInstalled(WalletType.EXTENSION);
      if (!installed) {
        setState({ status: "error", kind: "notInstalled" });
        return;
      }
      const wallets = await controller.connect(WalletType.EXTENSION, [
        { chainId: chain.chainId, rpc: chain.rpc, gasPrice: chain.gasPrice, sdkVersion: chain.sdkVersion },
      ]);
      const wallet = wallets.get(chain.chainId);
      if (!wallet) {
        setState({ status: "error", kind: "connectFailed" });
        return;
      }
      setState({ status: "connected", address: wallet.address, wallet });
    } catch {
      setState({ status: "error", kind: "rejected" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.chainId]);

  const disconnect = useCallback(() => {
    controllersRef.current.get(chain.chainId)?.disconnect([chain.chainId]);
    setState({ status: "disconnected" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.chainId]);

  // Switching the selected chain always starts from "disconnected" for the
  // newly selected one - each tab's connection is independent, so this
  // never auto-connects on the user's behalf.
  useEffect(() => {
    setState({ status: "disconnected" });
  }, [chain.chainId]);

  useEffect(() => {
    const controller = getController(chain.chainId);
    const unsubscribe = controller.onDisconnect(() => {
      setState({ status: "disconnected" });
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.chainId]);

  return { state, connect, disconnect };
}
