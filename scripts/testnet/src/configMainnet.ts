// Deliberately no `import "dotenv/config"` here (CodeRabbit finding,
// 2026-09-19 review, third round) - a stray .env in the working directory
// (e.g. left over from testnet setup) could otherwise silently supply
// ADMIN_MNEMONIC/COMMIT_PUSHER_MNEMONIC/KEEPER_MNEMONIC, contradicting
// requireEnv()'s own stated rule below ("never in .env for mainnet").
// Mainnet credentials must come only from a real shell env var export.
import { setChainSdkVersion, useChainSdkVersion } from "@goblinhunt/cosmes/protobufs";
import { MnemonicWallet } from "@goblinhunt/cosmes/wallet";

// Real production config for the mainnet redeploy of wheel-manager/
// weekly-round/create-your-own-luck/create-your-own-luck-factory - kept
// separate from ./config (rebel-2 testnet) and ./configMainnetTest (the
// discardable 2026-07 burn-tax test) so the mnemonics/addresses of the 3
// networks can never get mixed up by accident (same reasoning documented in
// those 2 files).
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

export const CHAIN_ID_SDK_VERSION = "sdk53" as const;
setChainSdkVersion(CHAIN_ID, CHAIN_ID_SDK_VERSION);
useChainSdkVersion(CHAIN_ID);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} - export it as a real shell env var before running (never in .env for mainnet).`);
  }
  return value;
}

// Real addresses, decided with the user 2026-09-10 (see the Obsidian mainnet
// deploy plan). TREASURY_ADDRESS is the 2-of-3 multisig, already tested with
// a real signed transfer. ADMIN_FEE_ADDRESS is the existing "fee keeper"
// wallet, already receiving real onramp fees.
export const TREASURY_ADDRESS = "terra1pmrw0x576skdqxel7aakph7nhjscuczn3kke0z";
export const ADMIN_FEE_ADDRESS = "terra1h3898lq8fyspnlvpwknl9ffu8pttyjvxl7kran";

export function loadWallet(envVar: string): MnemonicWallet {
  return new MnemonicWallet({
    mnemonic: requireEnv(envVar),
    bech32Prefix: BECH32_PREFIX,
    chainId: CHAIN_ID,
    rpc: RPC,
    gasPrice: GAS_PRICE,
    coinType: 330,
  });
}
