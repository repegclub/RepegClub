// Deliberately no `import "dotenv/config"` here (CodeRabbit finding,
// 2026-09-19 review, third round) - a stray .env in the working directory
// (e.g. left over from testnet setup) could otherwise silently supply
// ADMIN_MNEMONIC/COMMIT_PUSHER_MNEMONIC/KEEPER_MNEMONIC, contradicting
// requireEnv()'s own stated rule below ("never in .env for mainnet").
// Mainnet credentials must come only from a real shell env var export.
import { fromBech32 } from "@cosmjs/encoding";
import { setChainSdkVersion, useChainSdkVersion } from "@goblinhunt/cosmes/protobufs";
import { MnemonicWallet } from "@goblinhunt/cosmes/wallet";

// Real production config for the mainnet redeploy of wheel-manager/
// weekly-round/create-your-own-luck/create-your-own-luck-factory - kept
// separate from ./config (rebel-2 testnet) and ./configMainnetTest (the
// discardable 2026-07 burn-tax test) so the mnemonics/addresses of the 3
// networks can never get mixed up by accident (same reasoning documented in
// those 2 files). Chain/denom/gas/treasury/fee constants live in
// mainnetConstants.ts (re-exported below) so deployMainnetUiApp.ts - a
// browser tool that can't import this file's wallet logic - can share them
// instead of duplicating (CodeRabbit finding, 2026-09-20 review, seventh
// round).
export {
  CHAIN_ID,
  RPC,
  BECH32_PREFIX,
  DENOM,
  GAS_PRICE,
  TICKET_DENOM,
  REDEMPTION_DENOM,
  TREASURY_ADDRESS,
  ADMIN_FEE_ADDRESS,
} from "./mainnetConstants";
import { CHAIN_ID, BECH32_PREFIX, RPC, GAS_PRICE } from "./mainnetConstants";

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

// The 3 mainnet deploy scripts only ever need the commit_pusher wallet's
// ADDRESS (to set as instantiate's commit_pusher field) - they never sign
// as it. Loading COMMIT_PUSHER_MNEMONIC via loadWallet() just to read
// .address puts real signing material into a short-lived admin process that
// never needs it (CodeRabbit finding, 2026-09-20 review, eighth round,
// CWE-522). Prefer an address-only COMMIT_PUSHER_ADDRESS env var; fall back
// to deriving it from the mnemonic only if that isn't set, so existing
// setups keep working.
export function commitPusherAddress(): string {
  const explicit = process.env.COMMIT_PUSHER_ADDRESS;
  if (explicit) {
    if (fromBech32(explicit).prefix !== BECH32_PREFIX) {
      throw new Error(`COMMIT_PUSHER_ADDRESS "${explicit}" isn't a "${BECH32_PREFIX}1..." address.`);
    }
    return explicit;
  }
  return loadWallet("COMMIT_PUSHER_MNEMONIC").address;
}
