import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'

// @skip-go/widget's Solana ledger adapter references the bare global
// `Buffer` (not an import), which only Node provides natively - see
// vite.config.ts's matching "buffer" alias for the import-based half of
// this same fix.
window.Buffer = window.Buffer || Buffer

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
