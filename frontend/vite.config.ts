import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // @goblinhunt/cosmes's wallet module (via its WalletConnect dependency)
  // assumes Node's `global` exists - Vite doesn't polyfill Node globals for
  // the browser by default, so without this the app throws
  // "ReferenceError: global is not defined" as soon as a wallet controller
  // is constructed.
  define: {
    global: 'globalThis',
  },
  build: {
    // Vite's default build.target (chrome111/safari16.4 baseline) emits JS
    // syntax that in-app browsers inside wallet apps (Keplr's built-in
    // browser, etc.) can't always parse - those embed an older WebView
    // engine than the OS's real browser. When that happens the whole
    // module script fails to parse and nothing ever mounts, producing a
    // blank page with no visible error - reported live (site loads fine
    // in real mobile Chrome/Brave, blank inside Keplr's own browser).
    // Lowering the target broadens syntax compatibility. Floor is ES2020,
    // not lower - @noble/secp256k1 (wallet signing) uses native BigInt
    // literals (`1n`), which esbuild can't transform away for an older
    // target; anything below ES2020 (the first version with BigInt) would
    // just leave that syntax in place anyway and still fail to parse on an
    // engine that old, so there's no compatibility to gain by going lower.
    target: ['es2020', 'chrome80', 'safari14', 'firefox80'],
  },
})
