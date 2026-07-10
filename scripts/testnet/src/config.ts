import "dotenv/config";
import { setChainSdkVersion, useChainSdkVersion } from "@goblinhunt/cosmes/protobufs";
import { MnemonicWallet } from "@goblinhunt/cosmes/wallet";

export const CHAIN_ID = "rebel-2";
// luncblaze.com's node was found stale/unsynced 2026-07-08 (reported funded
// wallets as non-existent); hexxagon.dev was verified live and caught up.
export const RPC = "https://rpc.terra-classic.hexxagon.dev";
export const BECH32_PREFIX = "terra";
export const DENOM = "uluna";
// From https://terra-classic-fcd.publicnode.com/v1/txs/gas_prices (checked 2026-07-08)
export const GAS_PRICE = { amount: "28.325", denom: DENOM };

// rebel-2 and columbus-5 both run terra-classic-core v4.0.1 / Cosmos SDK v0.53.6
// (verified live 2026-07-08) - the cosmes fork defaults to the older sdk47 wire
// format, so this must run before building any tx.
setChainSdkVersion(CHAIN_ID, "sdk53");
useChainSdkVersion(CHAIN_ID);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in scripts/testnet/.env (copy .env.example and fill it in)`);
  }
  return value;
}

// Receive-only test addresses (no signing needed - Wheel Manager only ever
// sends funds to these, never requires a tx signed by them).
export const TREASURY_ADDRESS = "terra1juzyema7r4gvrrvrkkznceyeyhfkdj6zvz20fd";
export const ADMIN_FEE_ADDRESS = "terra15dv0f2rykyp6gyvuhawk8qgfd7ypm4lgkm4z39"; // "creator fee"

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
