// Step 2 of 2 for spending from the treasury multisig (2-of-3). Run this
// once both signers have run treasuryMultisigSign.ts and you have both
// resulting JSON files. Combines the 2 signatures into a valid multisig
// transaction and broadcasts it. No mnemonic needed here at all - only
// the 2 signature files.
//
// Usage: npx tsx src/treasuryMultisigBroadcast.ts sig-file-1.json sig-file-2.json

import { makeSignDoc, type AminoMsg, type StdFee } from "@cosmjs/amino";
import { makeMultisignedTxBytes } from "@cosmjs/stargate";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { readFileSync } from "fs";

import { CHAINS, MULTISIG_PUBKEY, multisigAddress } from "./treasuryMultisigConfig";

type SigFile = {
  chainKey: string;
  recipient: string;
  amount: string;
  denom: string;
  memo: string;
  accountNumber: number;
  sequence: number;
  fee: StdFee;
  signerAddressOnChain: string;
  signatureBase64: string;
};

async function main() {
  const [path1, path2] = process.argv.slice(2);
  if (!path1 || !path2) throw new Error("Usage: npx tsx src/treasuryMultisigBroadcast.ts sig-file-1.json sig-file-2.json");

  const sig1: SigFile = JSON.parse(readFileSync(path1, "utf8"));
  const sig2: SigFile = JSON.parse(readFileSync(path2, "utf8"));

  // Every field that went into the signed doc must match exactly between
  // both files, or at least one signature was made over different content
  // than the other and combining them would produce an invalid tx anyway -
  // caught here explicitly instead of failing opaquely at broadcast time.
  for (const key of ["chainKey", "recipient", "amount", "denom", "memo", "accountNumber", "sequence"] as const) {
    if (JSON.stringify(sig1[key]) !== JSON.stringify(sig2[key])) {
      throw new Error(`Mismatch on "${key}" between the two signature files - they weren't signing the same transaction.`);
    }
  }
  if (sig1.signerAddressOnChain === sig2.signerAddressOnChain) {
    throw new Error("Both files were signed by the same signer - need 2 DIFFERENT signers for a 2-of-3 multisig.");
  }

  const chain = CHAINS[sig1.chainKey];
  if (!chain) throw new Error(`Unknown chainKey "${sig1.chainKey}" in the signature files.`);
  const multisigAddr = multisigAddress(chain.bech32Prefix);

  // Rebuild the exact same StdSignDoc both signers actually signed, purely
  // as a sanity check that nothing here has drifted from what's in the
  // files (makeSignDoc is deterministic - not used for anything else below).
  const msgs: AminoMsg[] = [
    {
      type: "cosmos-sdk/MsgSend",
      value: { from_address: multisigAddr, to_address: sig1.recipient, amount: [{ denom: sig1.denom, amount: sig1.amount }] },
    },
  ];
  makeSignDoc(msgs, sig1.fee, chain.chainId, sig1.memo, sig1.accountNumber, sig1.sequence);

  // TxBody is encoded directly, NOT via Registry.encode() - Registry only
  // knows how to encode individual Msg types into Any (already done below
  // for MsgSend), not TxBody itself. Routing TxBody through
  // registry.encode() silently produced a corrupt body (empty
  // fromAddress/toAddress once decoded on-chain) - found live testing
  // against rebel-2 testnet, 2026-08-18, not caught by any type check.
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({
      messages: [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: MsgSend.encode(
            MsgSend.fromPartial({
              fromAddress: multisigAddr,
              toAddress: sig1.recipient,
              amount: [{ denom: sig1.denom, amount: sig1.amount }],
            })
          ).finish(),
        },
      ],
      memo: sig1.memo,
    })
  ).finish();

  const signatures = new Map<string, Uint8Array>([
    [sig1.signerAddressOnChain, Buffer.from(sig1.signatureBase64, "base64")],
    [sig2.signerAddressOnChain, Buffer.from(sig2.signatureBase64, "base64")],
  ]);

  const txBytes = makeMultisignedTxBytes(MULTISIG_PUBKEY, sig1.sequence, sig1.fee, bodyBytes, signatures);

  console.log(`Broadcasting on ${sig1.chainKey}: ${sig1.amount}${sig1.denom} from ${multisigAddr} to ${sig1.recipient}`);
  const res = await fetch(`${chain.lcd}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_bytes: Buffer.from(txBytes).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
