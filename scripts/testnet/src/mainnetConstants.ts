// Real production mainnet constants - chain/denom/gas/treasury/fee only, no
// wallet logic, no Node-only imports - safe to import from both Node
// scripts (configMainnet.ts) and browser tools (deployMainnetUiApp.ts).
// Split out so the two never drift out of sync (CodeRabbit finding,
// 2026-09-20 review, seventh round) - deployMainnetUiApp.ts used to
// hand-duplicate these values because configMainnet.ts's
// `import "dotenv/config"` broke browser bundling; that import was removed
// (2026-09-19 review, third round), so the original reason for duplicating
// no longer applies.

export const CHAIN_ID = "columbus-5";
export const RPC = "https://terra-classic-rpc.publicnode.com";
export const BECH32_PREFIX = "terra";
export const DENOM = "uluna";
// Checked live against https://terra-classic-fcd.publicnode.com/v1/txs/gas_prices
// on 2026-07-13 - same value used for every real mainnet tx in this project
// since (the treasury multisig test, the July burn-tax test).
export const GAS_PRICE = { amount: "28.325", denom: DENOM };

// Real ticket/redemption denoms for wheel-manager and weekly-round, decided
// with the user 2026-09-10 (see the Obsidian mainnet deploy plan): buy in
// USDC, redeem USTC 1:1. Both 6 decimals - verified live against Noble's own
// LCD (GET /cosmos/bank/v1beta1/denoms_metadata/uusdc), same as uluna.
export const TICKET_DENOM =
  "ibc/0BB9D8513E8E8E9AE6A9D211D9136E6DA42288DDE6CFAA453A150A4566054DC5"; // USDC via Noble
export const REDEMPTION_DENOM = "uusd"; // USTC, native

// Real addresses, decided with the user 2026-09-10 (see the Obsidian mainnet
// deploy plan). TREASURY_ADDRESS is the 2-of-3 multisig, already tested with
// a real signed transfer. ADMIN_FEE_ADDRESS is the existing "fee keeper"
// wallet, already receiving real onramp fees.
export const TREASURY_ADDRESS = "terra1pmrw0x576skdqxel7aakph7nhjscuczn3kke0z";
export const ADMIN_FEE_ADDRESS = "terra1h3898lq8fyspnlvpwknl9ffu8pttyjvxl7kran";
