// Shared constants for the treasury multisig signing tools
// (treasuryMultisigSign.ts / treasuryMultisigBroadcast.ts). Kept separate
// from deriveMultisigAddress.ts (which stays a standalone one-off) so both
// signing scripts compute the exact same multisig pubkey/address without
// copy-pasting the 3 signer pubkeys twice.

import { createMultisigThresholdPubkey, pubkeyToAddress, type Secp256k1Pubkey } from "@cosmjs/amino";

// Same 3 signer pubkeys as deriveMultisigAddress.ts - fill these in before
// using either script. Base64, "tendermint/PubKeySecp256k1" type (what
// Keplr/most wallets export as a signer's raw pubkey).
export const SIGNER_PUBKEYS_BASE64 = [
  "A821XkeGamQadFBpmkUX09jDVLg+HAflU2Z3J/ZUh2/m",
  "AoQLhMEq7qoCNUtLIRAljVt1SAfZ5P8FeHB/6sCF2KD5",
  "A1K8i1QK+1EaegipeJn/9jZHjvqjRfVdhPf1MB8W5ULe",
];
export const THRESHOLD = 2;

export const MULTISIG_PUBKEYS: Secp256k1Pubkey[] = SIGNER_PUBKEYS_BASE64.map((value) => ({
  type: "tendermint/PubKeySecp256k1",
  value,
}));
export const MULTISIG_PUBKEY = createMultisigThresholdPubkey(MULTISIG_PUBKEYS, THRESHOLD);

export type ChainSpec = {
  chainId: string;
  bech32Prefix: string;
  rpc: string;
  lcd: string;
  gasPrice: { amount: string; denom: string };
};

// Same 4 chains the treasury actually holds funds on (onrampConfig.ts).
export const CHAINS: Record<string, ChainSpec> = {
  "terra-classic": {
    chainId: "columbus-5",
    bech32Prefix: "terra",
    rpc: "https://terra-classic-rpc.publicnode.com",
    lcd: "https://terra-classic-fcd.publicnode.com",
    gasPrice: { amount: "28.325", denom: "uluna" },
  },
  noble: {
    chainId: "noble-1",
    bech32Prefix: "noble",
    rpc: "https://rpc.cosmos.directory/noble",
    lcd: "https://rest.cosmos.directory/noble",
    gasPrice: { amount: "0.1", denom: "uusdc" },
  },
  "cosmos-hub": {
    chainId: "cosmoshub-4",
    bech32Prefix: "cosmos",
    rpc: "https://rpc.cosmos.directory/cosmoshub",
    lcd: "https://rest.cosmos.directory/cosmoshub",
    gasPrice: { amount: "0.025", denom: "uatom" },
  },
  osmosis: {
    chainId: "osmosis-1",
    bech32Prefix: "osmo",
    rpc: "https://rpc.cosmos.directory/osmosis",
    lcd: "https://rest.cosmos.directory/osmosis",
    gasPrice: { amount: "0.1", denom: "uosmo" },
  },
};

export function multisigAddress(prefix: string): string {
  return pubkeyToAddress(MULTISIG_PUBKEY, prefix);
}
