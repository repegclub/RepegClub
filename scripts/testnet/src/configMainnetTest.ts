import "dotenv/config";
import { setChainSdkVersion, useChainSdkVersion } from "@goblinhunt/cosmes/protobufs";
import { MnemonicWallet } from "@goblinhunt/cosmes/wallet";

// One-off mainnet config for the 2026-07 real-USDC/USTC burn-tax
// verification test (see docs/terra-classic-chain-notes.md) - kept separate
// from ./config.ts (rebel-2 testnet) so the two networks/mnemonics can never
// get mixed up by accident.
export const CHAIN_ID = "columbus-5";
export const RPC = "https://terra-classic-rpc.publicnode.com";
export const BECH32_PREFIX = "terra";
export const DENOM = "uluna";
// Checked live against https://terra-classic-fcd.publicnode.com/v1/txs/gas_prices
// on 2026-07-13 - same value as the testnet config's note from 2026-07-08.
export const GAS_PRICE = { amount: "28.325", denom: DENOM };

// Real, governance-approved denoms (confirmed live against mainnet LCD and
// cross-checked against the official DEX pool) - see
// docs/terra-classic-chain-notes.md.
export const USTC_DENOM = "uusd";
export const USDC_DENOM =
  "ibc/0BB9D8513E8E8E9AE6A9D211D9136E6DA42288DDE6CFAA453A150A4566054DC5";

// rebel-2 and columbus-5 both run terra-classic-core v4.0.1 / Cosmos SDK v0.53.6
// (verified live 2026-07-08) - the cosmes fork defaults to the older sdk47 wire
// format, so this must run before building any tx.
setChainSdkVersion(CHAIN_ID, "sdk53");
useChainSdkVersion(CHAIN_ID);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in scripts/testnet/.env`);
  }
  return value;
}

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
