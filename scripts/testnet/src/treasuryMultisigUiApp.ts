// Browser tool for the treasury multisig (2-of-3), meant to replace running
// treasuryMultisigSign.ts/treasuryMultisigBroadcast.ts from a terminal with a
// raw mnemonic env var. Same 2-step flow, same underlying cosmjs logic - the
// only real change is that signing goes through Keplr (window.keplr.signAmino)
// instead of a Secp256k1HdWallet built from a mnemonic. Keplr never exposes
// the mnemonic to this page, only a signature.
//
// Local-only tool: run `npm run multisig-ui` and open the URL Vite prints.
// Not part of the deployed frontend.

import { fromBase64, toBase64 } from "@cosmjs/encoding";
import { makeSignDoc, type AminoMsg, type StdFee } from "@cosmjs/amino";
import { makeMultisignedTxBytes } from "@cosmjs/stargate";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import { CHAINS, MULTISIG_PUBKEY, SIGNER_PUBKEYS_BASE64, multisigAddress } from "./treasuryMultisigConfig";

declare global {
  interface Window {
    keplr?: {
      enable(chainId: string): Promise<void>;
      getKey(chainId: string): Promise<{ bech32Address: string; pubKey: Uint8Array; name: string }>;
      signAmino(
        chainId: string,
        signer: string,
        signDoc: unknown
      ): Promise<{ signed: unknown; signature: { pub_key: unknown; signature: string } }>;
    };
  }
}

// Every chain here uses 6 decimals for its gas/transfer denom - verified live
// for uluna and Noble's uusdc (GET /cosmos/bank/v1beta1/denoms_metadata/uusdc
// on a Noble LCD, 2026-09-10), and true by Cosmos SDK convention for uatom/
// uosmo too. If a chain with a different exponent is ever added to CHAINS,
// this needs to become a per-chain map instead of one constant.
const DENOM_EXPONENT = 6;

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

// Converts a human amount ("5" or "12.5") to the chain's micro-denom integer
// string via string manipulation, not floating point - avoids any rounding
// risk on a value that moves real funds.
function toMicroUnits(amountStr: string, exponent: number): string {
  const trimmed = amountStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`"${amountStr}" isn't a plain positive number.`);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > exponent) throw new Error(`Too many decimal places - this denom only has ${exponent}.`);
  const fracPadded = frac.padEnd(exponent, "0");
  const micro = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return micro;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in the page.`);
  return found as T;
}

function setStatus(id: string, message: string, isError = false) {
  const target = el<HTMLDivElement>(id);
  target.textContent = message;
  target.className = isError ? "status error" : "status";
}

// ---- Mode 1: propose + sign ----

async function proposeAndSign() {
  const chainKey = el<HTMLSelectElement>("chainKey").value;
  const recipient = el<HTMLInputElement>("recipient").value.trim();
  const amountHuman = el<HTMLInputElement>("amount").value.trim();
  const memo = el<HTMLInputElement>("memo").value.trim() || "REPEG CLUB treasury transfer";

  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unknown chain "${chainKey}".`);
  if (!recipient) throw new Error("Fill in a recipient address.");
  const amount = toMicroUnits(amountHuman, DENOM_EXPONENT);
  if (amount === "" || amount === "0") throw new Error("Amount must be greater than 0.");

  if (!window.keplr) throw new Error("Keplr not found - is the extension installed and unlocked?");
  await window.keplr.enable(chain.chainId);
  const key = await window.keplr.getKey(chain.chainId);
  const signerPubkeyBase64 = toBase64(key.pubKey);
  if (!SIGNER_PUBKEYS_BASE64.includes(signerPubkeyBase64)) {
    throw new Error(
      `The active Keplr account (${key.bech32Address}) isn't one of the 3 configured treasury signers. ` +
        `Switch accounts in Keplr and try again.`
    );
  }

  const multisigAddr = multisigAddress(chain.bech32Prefix);
  const accountRes = await fetch(`${chain.lcd}/cosmos/auth/v1beta1/accounts/${multisigAddr}`).then((r) => r.json());
  const baseAccount = accountRes.account?.base_account ?? accountRes.account;
  if (!baseAccount) throw new Error(`Couldn't find the treasury multisig account on ${chainKey} - has it ever received funds there?`);
  const accountNumber = Number(baseAccount.account_number);
  const sequence = Number(baseAccount.sequence);

  const msgs: AminoMsg[] = [
    {
      type: "cosmos-sdk/MsgSend",
      value: { from_address: multisigAddr, to_address: recipient, amount: [{ denom: chain.gasPrice.denom, amount }] },
    },
  ];
  // Same flat gas as treasuryMultisigSign.ts - verified live against a real
  // 2-of-3 broadcast on rebel-2 testnet, 2026-08-18.
  const gas = 350000;
  const feeAmount = Math.ceil(gas * Number(chain.gasPrice.amount));
  const fee: StdFee = { amount: [{ denom: chain.gasPrice.denom, amount: feeAmount.toString() }], gas: gas.toString() };

  const signDoc = makeSignDoc(msgs, fee, chain.chainId, memo, accountNumber, sequence);
  const { signature } = await window.keplr.signAmino(chain.chainId, key.bech32Address, signDoc);

  const sigFile: SigFile = {
    chainKey,
    recipient,
    amount,
    denom: chain.gasPrice.denom,
    memo,
    accountNumber,
    sequence,
    fee,
    signerAddressOnChain: key.bech32Address,
    signatureBase64: signature.signature,
  };

  const json = JSON.stringify(sigFile, null, 2);
  el<HTMLTextAreaElement>("sigOutput").value = json;
  setStatus(
    "signStatus",
    `Signed as ${key.bech32Address}. Copy the JSON below (or download it) and send it to the other signer.`
  );
}

function downloadSigFile() {
  const json = el<HTMLTextAreaElement>("sigOutput").value;
  if (!json) return;
  const parsed = JSON.parse(json) as SigFile;
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `treasury-sig-${parsed.chainKey}-${parsed.signerAddressOnChain.slice(-6)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Mode 2: combine + broadcast ----

async function combineAndBroadcast() {
  const raw1 = el<HTMLTextAreaElement>("sig1").value.trim();
  const raw2 = el<HTMLTextAreaElement>("sig2").value.trim();
  if (!raw1 || !raw2) throw new Error("Paste both signature JSON blobs first.");

  const sig1 = JSON.parse(raw1) as SigFile;
  const sig2 = JSON.parse(raw2) as SigFile;

  for (const key of ["chainKey", "recipient", "amount", "denom", "memo", "accountNumber", "sequence"] as const) {
    if (JSON.stringify(sig1[key]) !== JSON.stringify(sig2[key])) {
      throw new Error(`Mismatch on "${key}" between the two signatures - they weren't signing the same transaction.`);
    }
  }
  if (sig1.signerAddressOnChain === sig2.signerAddressOnChain) {
    throw new Error("Both signatures are from the same signer - need 2 DIFFERENT signers for a 2-of-3 multisig.");
  }

  const chain = CHAINS[sig1.chainKey];
  if (!chain) throw new Error(`Unknown chain "${sig1.chainKey}" in the signature files.`);
  const multisigAddr = multisigAddress(chain.bech32Prefix);

  // TxBody must be encoded directly (TxBody.encode), not via a Registry -
  // Registry only knows how to encode individual Msg types into Any, not
  // TxBody itself (see treasuryMultisigBroadcast.ts for the bug this avoids).
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

  // Keyed by each signer's bech32 ADDRESS, not their pubkey - same
  // requirement makeMultisignedTx has in the node script.
  const signatures = new Map<string, Uint8Array>([
    [sig1.signerAddressOnChain, fromBase64(sig1.signatureBase64)],
    [sig2.signerAddressOnChain, fromBase64(sig2.signatureBase64)],
  ]);

  const txBytes = makeMultisignedTxBytes(MULTISIG_PUBKEY, sig1.sequence, sig1.fee, bodyBytes, signatures);

  setStatus("broadcastStatus", `Broadcasting on ${sig1.chainKey}: ${sig1.amount}${sig1.denom} from ${multisigAddr} to ${sig1.recipient}...`);
  const res = await fetch(`${chain.lcd}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_bytes: toBase64(txBytes), mode: "BROADCAST_MODE_SYNC" }),
  });
  const body = await res.json();
  el<HTMLTextAreaElement>("broadcastOutput").value = JSON.stringify(body, null, 2);
  const code = body.tx_response?.code;
  if (code === 0) {
    setStatus("broadcastStatus", `Broadcast succeeded. txhash: ${body.tx_response.txhash}`);
  } else {
    setStatus("broadcastStatus", `Broadcast returned code ${code} - see the raw response below.`, true);
  }
}

el<HTMLButtonElement>("signButton").addEventListener("click", () => {
  proposeAndSign().catch((err) => setStatus("signStatus", err.message ?? String(err), true));
});
el<HTMLButtonElement>("downloadSigButton").addEventListener("click", downloadSigFile);
el<HTMLButtonElement>("broadcastButton").addEventListener("click", () => {
  combineAndBroadcast().catch((err) => setStatus("broadcastStatus", err.message ?? String(err), true));
});
