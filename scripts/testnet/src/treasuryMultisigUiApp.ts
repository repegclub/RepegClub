// Browser tool for the treasury multisig (2-of-3), meant to replace running
// treasuryMultisigSign.ts/treasuryMultisigBroadcast.ts from a terminal with a
// raw mnemonic env var. Same 2-step flow, same underlying cosmjs logic - the
// only real change is that signing goes through Keplr (window.keplr.signAmino)
// instead of a Secp256k1HdWallet built from a mnemonic. Keplr never exposes
// the mnemonic to this page, only a signature.
//
// Local-only tool: run `npm run multisig-ui` and open the URL Vite prints.
// Not part of the deployed frontend.

import { fromBase64, fromBech32, toBase64 } from "@cosmjs/encoding";
import { makeSignDoc, type AminoMsg, type StdFee, type StdSignDoc } from "@cosmjs/amino";
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
        signDoc: StdSignDoc
      ): Promise<{ signed: StdSignDoc; signature: { pub_key: unknown; signature: string } }>;
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
  // A wrong-prefix address (e.g. a Terra address pasted while "Noble" is
  // selected) used to only fail at broadcast time, after both signers had
  // already signed (CodeRabbit finding, 2026-09-19 review) - catch it here
  // instead.
  let decodedRecipient: { prefix: string };
  try {
    decodedRecipient = fromBech32(recipient);
  } catch {
    throw new Error(`"${recipient}" isn't a valid bech32 address.`);
  }
  if (decodedRecipient.prefix !== chain.bech32Prefix) {
    throw new Error(
      `"${recipient}" has prefix "${decodedRecipient.prefix}", but ${chainKey} addresses start with "${chain.bech32Prefix}1...".`
    );
  }
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
  // Bounded deadline so a stalled LCD can't hang this indefinitely - without
  // it, signButton (locked while this is pending, see below) would stay
  // disabled forever with no error shown (same class of gap CodeRabbit
  // found twice already in keeperMainnet.ts/generateAndPushCommitsMainnet.ts,
  // 2026-09-19 review - applied here proactively).
  const accountRes = await fetch(`${chain.lcd}/cosmos/auth/v1beta1/accounts/${multisigAddr}`, {
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json());
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
  // Keplr may override fee/memo when preferNoSetFee/preferNoSetMemo aren't
  // set (CodeRabbit finding, 2026-09-19 review) - `signed` is the document
  // the signature actually covers, which can differ from the `signDoc` we
  // requested. Persist `signed`'s own fee/memo, not our original request, or
  // the signature combineAndBroadcast() later verifies against won't match
  // what's broadcast.
  const { signed, signature } = await window.keplr.signAmino(chain.chainId, key.bech32Address, signDoc);

  // Persist the COMPLETE signed document Keplr actually covered with its
  // signature, not just fee/memo (CodeRabbit finding, 2026-09-20 review,
  // eleventh round, extending the fix above) - msgs/account_number/sequence
  // are amino fields Keplr is technically free to alter too (see
  // AminoSignResponse's own doc comment: "This may differ from the input
  // signDoc"), even though its default UI only ever exposes fee/memo for
  // editing. Building the multisig tx from anything other than exactly what
  // was signed risks a signature that doesn't verify against the broadcast
  // transaction.
  const signedMsg = signed.msgs[0]?.value as { to_address?: string; amount?: { denom: string; amount: string }[] } | undefined;
  const signedAmountEntry = signedMsg?.amount?.[0];
  if (!signedMsg?.to_address || !signedAmountEntry) {
    throw new Error("Keplr returned a signed document with an unexpected message shape - refusing to sign.");
  }

  const sigFile: SigFile = {
    chainKey,
    recipient: signedMsg.to_address,
    amount: signedAmountEntry.amount,
    denom: signedAmountEntry.denom,
    memo: signed.memo,
    accountNumber: Number(signed.account_number),
    sequence: Number(signed.sequence),
    fee: signed.fee,
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

// BROADCAST_MODE_SYNC's code===0 only means CheckTx accepted the tx into the
// mempool, not that it executed successfully in a block (CodeRabbit finding,
// 2026-09-19 review) - poll the tx hash until it's actually included and
// report the real DeliverTx/block execution code.
async function pollTxResult(
  lcd: string,
  txhash: string,
  maxAttempts = 15,
  intervalMs = 2000
): Promise<{ code: number; rawLog?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      // A stalled request here would defeat maxAttempts entirely without a
      // bounded deadline - one hung fetch could block the whole retry loop
      // forever instead of just costing one attempt. Wrapped in try/catch
      // (added alongside the timeout, noticed while fixing it) so a single
      // transient network error/timeout costs one attempt, not the whole
      // poll - a plain network error here used to abort pollTxResult
      // immediately instead of retrying.
      const res = await fetch(`${lcd}/cosmos/tx/v1beta1/txs/${txhash}`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) {
        const body = await res.json();
        if (body.tx_response) return { code: body.tx_response.code, rawLog: body.tx_response.raw_log };
      }
    } catch {
      // Transient - fall through to the next attempt.
    }
  }
  throw new Error(`Timed out waiting for txhash ${txhash} to land in a block - check it manually.`);
}

// ---- Mode 2: combine + broadcast ----

async function combineAndBroadcast() {
  const raw1 = el<HTMLTextAreaElement>("sig1").value.trim();
  const raw2 = el<HTMLTextAreaElement>("sig2").value.trim();
  if (!raw1 || !raw2) throw new Error("Paste both signature JSON blobs first.");

  const sig1 = JSON.parse(raw1) as SigFile;
  const sig2 = JSON.parse(raw2) as SigFile;

  for (const key of ["chainKey", "recipient", "amount", "denom", "memo", "accountNumber", "sequence", "fee"] as const) {
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
  // Bounded deadline, same reasoning as the fetches above - if this hangs,
  // broadcastButton (locked while pending) would stay disabled forever
  // with no error. A signed tx is safe to resubmit if a timeout fires
  // before a response arrives - the chain rejects an already-seen tx
  // rather than double-spending it.
  const res = await fetch(`${chain.lcd}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_bytes: toBase64(txBytes), mode: "BROADCAST_MODE_SYNC" }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  el<HTMLTextAreaElement>("broadcastOutput").value = JSON.stringify(body, null, 2);
  const code = body.tx_response?.code;
  if (code !== 0) {
    setStatus("broadcastStatus", `Broadcast returned code ${code} - see the raw response below.`, true);
    return;
  }

  const txhash = body.tx_response.txhash;
  setStatus("broadcastStatus", `Accepted into mempool (txhash: ${txhash}). Waiting for it to land in a block...`);
  try {
    const finalResult = await pollTxResult(chain.lcd, txhash);
    if (finalResult.code === 0) {
      setStatus("broadcastStatus", `Broadcast succeeded. txhash: ${txhash}`);
    } else {
      setStatus(
        "broadcastStatus",
        `Accepted into mempool but FAILED on-chain (code ${finalResult.code}): ${finalResult.rawLog ?? "see raw response above"}. txhash: ${txhash}`,
        true
      );
    }
  } catch (err) {
    setStatus(
      "broadcastStatus",
      `Accepted into mempool (txhash: ${txhash}) but couldn't confirm block inclusion: ${(err as Error).message ?? String(err)}`,
      true
    );
  }
}

const chainKeySelect = el<HTMLSelectElement>("chainKey");
const recipientInput = el<HTMLInputElement>("recipient");
function updateRecipientPlaceholder() {
  const chain = CHAINS[chainKeySelect.value];
  recipientInput.placeholder = chain ? `${chain.bech32Prefix}1...` : "";
}
chainKeySelect.addEventListener("change", updateRecipientPlaceholder);
updateRecipientPlaceholder();

const signButton = el<HTMLButtonElement>("signButton");
signButton.addEventListener("click", () => {
  // Without this lock, a second click while Keplr/the network call is still
  // pending starts a second proposeAndSign() that overwrites the same
  // sigOutput/signStatus mid-flight (CodeRabbit finding, 2026-09-19 review).
  signButton.disabled = true;
  setStatus("signStatus", "Waiting for Keplr to complete signing...");
  proposeAndSign()
    .catch((err) => setStatus("signStatus", err.message ?? String(err), true))
    .finally(() => {
      signButton.disabled = false;
    });
});
el<HTMLButtonElement>("downloadSigButton").addEventListener("click", downloadSigFile);
const broadcastButton = el<HTMLButtonElement>("broadcastButton");
broadcastButton.addEventListener("click", () => {
  // Same double-click race as signButton above (CodeRabbit finding,
  // 2026-09-19 review, second round) - a second combineAndBroadcast() call
  // while the first is still pending can overwrite broadcastStatus/
  // broadcastOutput with a later CheckTx result.
  broadcastButton.disabled = true;
  combineAndBroadcast()
    .catch((err) => setStatus("broadcastStatus", err.message ?? String(err), true))
    .finally(() => {
      broadcastButton.disabled = false;
    });
});
