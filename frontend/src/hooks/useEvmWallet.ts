import { useCallback, useEffect, useRef, useState } from "react";
import { getAddress, type EIP1193Provider, type Hex } from "viem";
import { useLatestRequest } from "./useLatestRequest";

// Browser-extension EVM wallets only (MetaMask, Rabby, Keplr's EVM side...),
// discovered with EIP-6963 so several installed extensions don't fight over
// window.ethereum. No WalletConnect on purpose (product decision,
// 2026-10-02): on a phone, open the site inside the wallet's own browser.
export type EvmProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
export type EvmProviderDetail = { info: EvmProviderInfo; provider: EIP1193Provider };

export type EvmWalletState =
  | { status: "disconnected" }
  | { status: "connecting"; uuid: string }
  | { status: "connected"; address: Hex; detail: EvmProviderDetail }
  | { status: "error"; uuid: string; message: string };

// Used only when no extension answers EIP-6963 but an injected provider
// exists anyway (older wallets).
const LEGACY_UUID = "legacy-window-ethereum";

type EthereumWindow = Window & { ethereum?: EIP1193Provider };

function useEvmProviders(): EvmProviderDetail[] {
  const [providers, setProviders] = useState<EvmProviderDetail[]>([]);

  useEffect(() => {
    function onAnnounce(event: Event) {
      const detail = (event as CustomEvent<EvmProviderDetail>).detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      setProviders((prev) => (prev.some((p) => p.info.uuid === detail.info.uuid) ? prev : [...prev, detail]));
    }
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Extensions answer synchronously or within a tick; give slow ones a
    // moment before falling back to window.ethereum.
    const fallback = setTimeout(() => {
      const injected = (window as EthereumWindow).ethereum;
      if (!injected) return;
      setProviders((prev) =>
        prev.length > 0
          ? prev
          : [{ info: { uuid: LEGACY_UUID, name: "Browser wallet", icon: "", rdns: "" }, provider: injected }]
      );
    }, 500);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(fallback);
    };
  }, []);

  return providers;
}

export function useEvmWallet() {
  const providers = useEvmProviders();
  const [state, setState] = useState<EvmWalletState>({ status: "disconnected" });
  const { start, isCurrent } = useLatestRequest();
  // The provider whose accountsChanged listener is attached right now, so
  // it can be detached on disconnect/switch/unmount.
  const listenerRef = useRef<{ provider: EIP1193Provider; handler: (accounts: string[]) => void } | null>(null);

  const detach = useCallback(() => {
    const current = listenerRef.current;
    if (current) current.provider.removeListener("accountsChanged", current.handler);
    listenerRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    start(); // invalidates any connect still waiting on the wallet
    detach();
    setState({ status: "disconnected" });
  }, [start, detach]);

  const connect = useCallback(
    async (detail: EvmProviderDetail) => {
      const token = start();
      detach();
      setState({ status: "connecting", uuid: detail.info.uuid });
      try {
        const accounts = (await detail.provider.request({ method: "eth_requestAccounts" })) as string[];
        if (!isCurrent(token)) return;
        if (!accounts[0]) throw new Error("The wallet didn't share an account.");
        // Switching accounts inside the extension changes who signs - the
        // form follows it instead of showing (and checking balances of) the
        // old address. An empty list means the site was disconnected.
        const handler = (next: string[]) => {
          if (!isCurrent(token)) return;
          if (!next[0]) {
            detach();
            setState({ status: "disconnected" });
          } else {
            setState({ status: "connected", address: getAddress(next[0]), detail });
          }
        };
        detail.provider.on("accountsChanged", handler);
        listenerRef.current = { provider: detail.provider, handler };
        setState({ status: "connected", address: getAddress(accounts[0]), detail });
      } catch (err) {
        if (!isCurrent(token)) return;
        setState({
          status: "error",
          uuid: detail.info.uuid,
          message: err instanceof Error ? err.message : "Couldn't connect the wallet.",
        });
      }
    },
    [start, isCurrent, detach]
  );

  useEffect(() => detach, [detach]);

  return { providers, state, connect, disconnect };
}
