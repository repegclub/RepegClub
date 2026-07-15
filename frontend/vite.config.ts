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
})
