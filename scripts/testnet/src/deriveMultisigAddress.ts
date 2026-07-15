import { createMultisigThresholdPubkey, pubkeyToAddress, type Secp256k1Pubkey } from "@cosmjs/amino";

// Paste the base64 pubkeys copied from getPubkey.html, one per signer.
const SIGNER_PUBKEYS_BASE64 = [
  "A821XkeGamQadFBpmkUX09jDVLg+HAflU2Z3J/ZUh2/m",
  "AoQLhMEq7qoCNUtLIRAljVt1SAfZ5P8FeHB/6sCF2KD5",
  "A1K8i1QK+1EaegipeJn/9jZHjvqjRfVdhPf1MB8W5ULe",
];
const THRESHOLD = 2;
const BECH32_PREFIX = "terra";

if (SIGNER_PUBKEYS_BASE64.some((p) => !p)) {
  throw new Error("Fill in all 3 signer pubkeys before running this script.");
}

const pubkeys: Secp256k1Pubkey[] = SIGNER_PUBKEYS_BASE64.map((value) => ({
  type: "tendermint/PubKeySecp256k1",
  value,
}));

const multisigPubkey = createMultisigThresholdPubkey(pubkeys, THRESHOLD);
const address = pubkeyToAddress(multisigPubkey, BECH32_PREFIX);

console.log(`Multisig address (${THRESHOLD}-of-${pubkeys.length}): ${address}`);
