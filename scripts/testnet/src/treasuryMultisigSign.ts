// Step 1 of 2 for spending from the treasury multisig (2-of-3). Each of the
// 2 signers runs THIS script separately, on their own machine, with their
// OWN mnemonic - never both mnemonics in the same place. Produces a small
// JSON file with just a signature (safe to hand to whoever runs step 2 -
// see treasuryMultisigBroadcast.ts - a signature alone can't move funds
// without the second signer's signature too).
//
// Usage (edit the constants below for the real transfer, then run):
//   SIGNER_MNEMONIC="your 12-24 words" npx tsx src/treasuryMultisigSign.ts
// Real shell env var, not a line in .env - same rule as every other
// real-fund mnemonic in this project (see .env.example).

import { makeSignDoc, pubkeyToAddress, Secp256k1HdWallet, type AminoMsg, type StdFee } from "@cosmjs/amino";
import { stringToPath } from "@cosmjs/crypto";
import { writeFileSync } from "fs";

import { CHAINS, SIGNER_PUBKEYS_BASE64, multisigAddress } from "./treasuryMultisigConfig";

// ---- Edit these for the real transfer, then re-run for each signer ----
const CHAIN_KEY = "noble"; // one of: terra-classic, noble, cosmos-hub, osmosis
const RECIPIENT = ""; // fill in before running
const AMOUNT = ""; // in the chain's own micro-denom (e.g. "100" = 0.0001 for a 6-decimal denom)
const MEMO = "REPEG CLUB treasury transfer";
// This signer's own HD path/coin type - whatever was actually used to
// generate the pubkey pasted into SIGNER_PUBKEYS_BASE64 in
// treasuryMultisigConfig.ts. NOT necessarily the target chain's own coin
// type - a signer's individual key doesn't have to be derived the same
// way as the chain being spent on. Get this wrong and the derived pubkey
// simply won't match any of the 3 configured ones (checked below), so
// there's no risk of silently signing with the wrong key.
const SIGNER_COIN_TYPE = 330;
const SIGNER_BECH32_PREFIX = "terra";
// -------------------------------------------------------------------

async function main() {
  const chain = CHAINS[CHAIN_KEY];
  if (!chain) throw new Error(`Unknown CHAIN_KEY "${CHAIN_KEY}" - see CHAINS in treasuryMultisigConfig.ts.`);
  if (!RECIPIENT || !AMOUNT) throw new Error("Fill in RECIPIENT and AMOUNT before running this script.");

  const mnemonic = process.env.SIGNER_MNEMONIC;
  if (!mnemonic) throw new Error("Missing SIGNER_MNEMONIC - export it as a real shell env var before running.");

  const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    hdPaths: [stringToPath(`m/44'/${SIGNER_COIN_TYPE}'/0'/0/0`)],
    prefix: SIGNER_BECH32_PREFIX,
  });
  const [account] = await wallet.getAccounts();
  const signerPubkeyBase64 = Buffer.from(account.pubkey).toString("base64");
  if (!SIGNER_PUBKEYS_BASE64.includes(signerPubkeyBase64)) {
    throw new Error(
      `Derived pubkey (${signerPubkeyBase64}) isn't one of the 3 configured treasury signers - ` +
        `wrong mnemonic, wrong SIGNER_COIN_TYPE, or wrong path. Refusing to sign.`
    );
  }
  console.log(`Signing as: ${account.address} (matches a configured treasury signer)`);

  const multisigAddr = multisigAddress(chain.bech32Prefix);
  const accountRes = await fetch(`${chain.lcd}/cosmos/auth/v1beta1/accounts/${multisigAddr}`).then((r) => r.json());
  const baseAccount = accountRes.account?.base_account ?? accountRes.account;
  if (!baseAccount) throw new Error(`Couldn't find the treasury multisig account on ${CHAIN_KEY} - has it ever received funds there?`);
  const accountNumber = Number(baseAccount.account_number);
  const sequence = Number(baseAccount.sequence);
  console.log(`Treasury (${multisigAddr}) account_number=${accountNumber} sequence=${sequence}`);

  const msgs: AminoMsg[] = [
    {
      type: "cosmos-sdk/MsgSend",
      value: {
        from_address: multisigAddr,
        to_address: RECIPIENT,
        amount: [{ denom: chain.gasPrice.denom, amount: AMOUNT }],
      },
    },
  ];
  // Generous flat gas (verified live against a real 2-of-3 broadcast on
  // rebel-2 testnet, 2026-08-18 - Terra Classic's gas metering needs more
  // than a standard Cosmos chain would for the same single MsgSend, likely
  // the burn-tax computation itself; kept the same for every chain here
  // rather than tuning it lower per chain for a one-off tool).
  const gas = 350000;
  const feeAmount = Math.ceil(gas * Number(chain.gasPrice.amount));
  const fee: StdFee = { amount: [{ denom: chain.gasPrice.denom, amount: feeAmount.toString() }], gas: gas.toString() };

  const signDoc = makeSignDoc(msgs, fee, chain.chainId, MEMO, accountNumber, sequence);
  const { signature } = await wallet.signAmino(account.address, signDoc);

  // makeMultisignedTx (in treasuryMultisigBroadcast.ts) looks up each
  // signature by the signer's bech32 ADDRESS on the target chain - derived
  // from the multisig's own pubkey list re-encoded with that chain's
  // prefix, not this signer's own configured SIGNER_BECH32_PREFIX (verified
  // against @cosmjs/stargate's actual source, 2026-08-18 - its .d.ts alone
  // doesn't document this, only the implementation does).
  const signerAddressOnChain = pubkeyToAddress({ type: "tendermint/PubKeySecp256k1", value: signerPubkeyBase64 }, chain.bech32Prefix);

  const outFile = `treasury-sig-${CHAIN_KEY}-${account.address.slice(-6)}.json`;
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        chainKey: CHAIN_KEY,
        recipient: RECIPIENT,
        amount: AMOUNT,
        denom: chain.gasPrice.denom,
        memo: MEMO,
        accountNumber,
        sequence,
        fee,
        signerAddressOnChain,
        signatureBase64: signature.signature,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${outFile} - hand this (and the matching file from the other signer) to whoever runs treasuryMultisigBroadcast.ts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
