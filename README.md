# Repeg Club

Platform on Terra Classic (LUNC). Flagship product: **Wheel of Repeg**, a
lottery-style game where players buy a ticket to enter a round; the winner
gets the right to redeem their own USTC for USDC at 1:1, up to that round's
pool.

Live site: https://repegclub.com

## Structure

- `contracts/` — CosmWasm/Rust smart contracts: `wheel-manager`, `weekly-round`,
  `create-your-own-luck`.
- `frontend/` — the production site (React + Vite + TypeScript).
- `scripts/testnet/` — deploy scripts, the keeper bot, and verification tools.
- `docs/` — design and chain notes.
