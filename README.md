# Repeg Club

Platform on Terra Classic (LUNC). Flagship product: **Wheel of Repeg**, a
lottery-style game where players buy a ticket to enter a round; the winner
gets the right to redeem their own USTC for USDC at 1:1, up to that round's
pool.

Live site: https://repegclub.com

This repository is public so anyone — a player, a developer, or an AI —
can read the contract and frontend code directly, instead of having to
trust our word for how the game works. Every round can also be verified
independently: the site's "Verify this round" panel recalculates the
draw in your own browser against two public sources (a real block hash
and the on-chain ticket list) and shows the full math behind it. Code is
shared for transparency only — see [LICENSE](LICENSE).

## Structure

- `contracts/` — CosmWasm/Rust smart contracts: `wheel-manager`, `weekly-round`,
  `create-your-own-luck`.
- `frontend/` — the production site (React + Vite + TypeScript).
- `scripts/testnet/` — deploy scripts, the keeper bot, and verification tools.
- `docs/` — design and chain notes.
