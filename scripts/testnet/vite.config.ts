import { defineConfig } from "vite";

// Local dev-server config for the 2 browser tools in this folder
// (treasuryMultisigUI.html, deployMainnetUI.html) - not used by any of the
// node scripts (tsx doesn't read this file).
//
// `global` is replaced at build/transform time (not a runtime polyfill) -
// @goblinhunt/cosmes/wallet pulls in @walletconnect/legacy-client for its
// WalletConnect (mobile/QR) support, which references Node's `global` at
// module top level even though this project only ever uses the browser-
// extension connection path. Without this, the whole module - and every
// event listener deployMainnetUiApp.ts sets up - fails to load at all
// ("ReferenceError: global is not defined"), silently (no visible error on
// the page itself, only in the Vite terminal log) - found live, 2026-09-10.
export default defineConfig({
  define: {
    global: "globalThis",
  },
});
