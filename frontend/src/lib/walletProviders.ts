import { GalaxyStationController, KeplrController, type WalletController } from "@goblinhunt/cosmes/wallet";

// Every wallet this site can connect to. Both controllers come from
// @goblinhunt/cosmes (same SDK already validated elsewhere in the project)
// and share an identical WalletController interface (isInstalled/connect/
// disconnect/onDisconnect) - adding a new provider here is just one more
// entry, no per-caller special-casing needed.
export type WalletProviderId = "keplr" | "galaxystation";

export type WalletProviderInfo = {
  id: WalletProviderId;
  name: string;
  installUrl: string;
  create: (wcProjectId: string) => WalletController;
};

export const WALLET_PROVIDERS: WalletProviderInfo[] = [
  {
    id: "keplr",
    name: "Keplr",
    installUrl: "https://www.keplr.app/",
    create: (wcProjectId) => new KeplrController(wcProjectId),
  },
  {
    id: "galaxystation",
    name: "Galaxy Station",
    // Chrome Web Store, not station.hexxagon.io - that domain is the web
    // app, not the browser-extension download (found in CodeRabbit review,
    // PR #35 - confirmed live via web search before fixing).
    installUrl: "https://chromewebstore.google.com/detail/galaxy-station-wallet/akckefnapafjbpphkefbpkpcamkoaoai",
    create: (wcProjectId) => new GalaxyStationController(wcProjectId),
  },
];

export type WalletErrorKind = "notInstalled" | "connectFailed" | "rejected";
