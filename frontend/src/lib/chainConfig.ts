import { setChainSdkVersion, useChainSdkVersion } from "@goblinhunt/cosmes/protobufs";

// Testnet for now - matches scripts/testnet/src/config.ts. Switch to mainnet
// (columbus-5) once the product actually launches; RPC/LCD are both from the
// same provider (hexxagon.dev) for this chain, but that isn't a requirement -
// any live, in-sync rebel-2 node works for either.
export const CHAIN_ID: string = "rebel-2";
export const RPC = "https://rpc.terra-classic.hexxagon.dev";
// REST/LCD endpoint - used only for building a plain-URL "check this
// yourself" link in the round-verification panel (see verifyRound.ts); all
// real contract reads/writes go through RPC via cosmes above.
export const LCD = "https://lcd.terra-classic.hexxagon.dev";
export const BECH32_PREFIX = "terra";
export const GAS_PRICE = { amount: "28.325", denom: "uluna" };
// Drives the always-visible network badge in the wallet bar (see
// components/Wallet/NetworkBadge.tsx) - real money is at stake once this
// flips, so it needs to be impossible to miss on-screen, not just a code
// comment like the line above.
export const IS_MAINNET = CHAIN_ID === "columbus-5";

// rebel-2 and columbus-5 both run terra-classic-core v4.0.1 / Cosmos SDK
// v0.53.6 (verified live 2026-07-08) - the cosmes fork defaults to the older
// sdk47 wire format, so this must run before building any tx.
setChainSdkVersion(CHAIN_ID, "sdk53");
useChainSdkVersion(CHAIN_ID);
