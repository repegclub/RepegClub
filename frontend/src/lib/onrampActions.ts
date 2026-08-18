import { MsgExecuteContract, MsgIbcTransfer, MsgSend, type Adapter } from "@goblinhunt/cosmes/client";
import { bech32, resolveBech32Address } from "@goblinhunt/cosmes/codec";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import {
  KNOWN_SLIP44_118_CHAIN_IDS,
  KNOWN_SLIP44_118_CHAIN_PREFIXES,
  NOBLE_CHAIN_ID,
  NOBLE_USDC_DENOM,
  NOBLE_TO_TERRA_CLASSIC_CHANNEL,
  SKIP_ENTRY_POINT_CONTRACT_ADDRESSES,
  TERRA_CLASSIC_CHAIN_ID,
  TERRA_CLASSIC_USDC_DENOM,
  getDirectFeeSplit,
  type DirectOriginAsset,
  type DirectOriginChain,
} from "./onrampConfig";

// Same memo convention as every other tx this project broadcasts
// (roundActions.ts, cyolActions.ts).
const MEMO = "REPEG CLUB";
const SKIP_API_BASE = "https://api.skip.build/v2";

// Terra Classic's receiver is never derived from the connected origin
// wallet's pubkey - Terra Classic (and Terra 2.0) use a non-standard
// SLIP-44 coin type (330) in Keplr's own default registry, unlike Noble/
// Cosmos Hub/Osmosis (118, the Cosmos ecosystem's usual default) -
// re-encoding a 118-derived pubkey with the "terra" prefix produces a
// real but DIFFERENT address than the one Keplr shows the user by
// default for Terra Classic (confirmed live against Keplr's own chain
// registry and the Cosmos chain-registry's slip44 field, 2026-08-15 -
// this was a real bug in an earlier version of this file). The user
// pastes their own Terra Classic address instead, same as withdrawing to
// any external wallet on an exchange - they're responsible for pasting
// the right one, same trust model as everywhere else that pattern is
// used. This only checks that it's a *structurally valid* terra1...
// address (real bech32 checksum, not just a lookalike string) - it
// can't and doesn't try to confirm it's actually the pasting user's own
// address.
export function isValidTerraClassicAddress(address: string): boolean {
  try {
    return bech32.decode(address as `${string}1${string}`).prefix === "terra";
  } catch {
    return false;
  }
}

// Only used for chains confirmed to share the origin wallet's own coin
// type (118) - see KNOWN_SLIP44_118_CHAIN_IDS in onrampConfig.ts. Safe
// there in a way it is NOT for Terra Classic (see isValidTerraClassicAddress
// above). Same resolveBech32Address re-encoding already used (and
// verified against a real Keplr-displayed address) for the treasury/
// fee-keeper wallets - see scripts/testnet/src/deriveMultisigAddress.ts
// and project notes, 2026-07-13 (those are HD-path-independent multisig
// pubkeys though, a different case from a user's own HD-derived account).
function deriveAddress(wallet: ConnectedWallet, bech32Prefix: string): string {
  return resolveBech32Address(wallet.pubKey.toAmino().value.key, bech32Prefix);
}

type SkipRoute = {
  source_asset_denom: string;
  source_asset_chain_id: string;
  dest_asset_denom: string;
  dest_asset_chain_id: string;
  amount_in: string;
  amount_out: string;
  operations: unknown[];
  chain_ids: string[];
  txs_required: number;
};

async function fetchSkipRoute(originChainId: string, originDenom: string, amountIn: bigint): Promise<SkipRoute> {
  const res = await fetch(`${SKIP_API_BASE}/fungible/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount_in: amountIn.toString(),
      source_asset_denom: originDenom,
      source_asset_chain_id: originChainId,
      dest_asset_denom: TERRA_CLASSIC_USDC_DENOM,
      dest_asset_chain_id: TERRA_CLASSIC_CHAIN_ID,
      // false, not true - this project only ever signs a route that
      // collapses into one Cosmos tx anyway (see fetchSkipMsg below), so
      // there's no point asking Skip to also consider routes that would
      // need more than one - asking for those only risks Skip preferring
      // a multi-tx route over a single-tx one that also exists.
      allow_multi_tx: false,
    }),
  });
  if (!res.ok) throw new Error(`Skip route query failed (${res.status})`);
  return res.json();
}

type SkipMultiChainMsg = { chain_id: string; msg_type_url: string; msg: string; path: string[] };

// Recursively walks a Skip PFM/IBC-hooks payload and returns every address
// found at a "funds actually land or bounce back here" position - not
// routing metadata like pool/venue identifiers, which are left alone (see
// buildAdapterFromSkipMsg below for why). FAILS CLOSED: any shape this
// project hasn't specifically confirmed against a real broadcast tx throws
// rather than silently returning no findings (first version of this
// function did the opposite - found in review, 2026-08-17, by two
// independent blind auditors: Skip's real entry-point contract also
// defines `contract_call`/`hpl_transfer` post-swap actions, and PFM's
// `forward.next` can legitimately arrive as a JSON *string* instead of an
// object - both silently skipped every address check that followed them).
// A validator whose only job is to police untrusted input must reject the
// unrecognized, not wave it through.
//
// Two shapes confirmed live against real, successfully-broadcast mainnet
// txs (2026-08-16, re-verified 2026-08-17 against Skip's own contract
// source at github.com/skip-mev/skip-go-cosmwasm-contracts):
//   - Plain multi-hop forward: {"forward": {"receiver": "...", "next": {...}?}}
//   - IBC-hooks swap+forward, either as a MsgTransfer's `memo` (wrapped in
//     "wasm") or as a MsgExecuteContract's `msg` (bare):
//     {"swap_and_action": {"affiliates": [], "post_swap_action": {
//       "ibc_transfer": {"ibc_info": {"receiver": "...", "recover_address": "...", "memo": "<JSON string, recurse>"}, "fee_swap": {"refund_address": "..."}}
//       | "transfer": {"to_address": "..."}
//     }}}
// Shared by both branches below (MsgTransfer's memo and MsgExecuteContract's
// msg) - found in review (2026-08-18, CodeRabbit): the two loops had
// already drifted once (the entry-point exemption was granted to the first
// hop's memo only, fixed 2026-08-17), a real risk of two copies of the same
// check re-diverging.
function assertReceiversAllowed(node: unknown, validReceivers: Set<string>): void {
  for (const addr of collectSkipReceivers(node)) {
    if (!validReceivers.has(addr) && !SKIP_ENTRY_POINT_CONTRACT_ADDRESSES.has(addr)) {
      throw new Error("Skip's response forwards funds to an unexpected address - refusing to sign.");
    }
  }
}

function collectSkipReceivers(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const found: string[] = [];
  // CRITICAL BUG FOUND IN REVIEW (2026-08-17, second blind-audit pass): the
  // first version of this fail-closed rewrite only failed closed on a
  // *malformed instance* of a recognized key (forward/wasm/swap_and_action)
  // - an object with NONE of those keys still fell through to `return
  // found` with an empty array, same silent-pass bug this rewrite was
  // supposed to close, just one level up. Skip's real entry-point contract
  // (verified against its own source, skip-mev/skip-go-cosmwasm-contracts)
  // exposes several other externally-callable message shapes with no
  // sender restriction - `action`/`action_with_recover` in particular -
  // that deliver funds via an arbitrary `Action::Transfer{to_address}`
  // with zero validation from this project. A forged response using one of
  // those shapes passed every check that existed at the time: chain_id,
  // sender, denom/amount, and the entry-point allowlist (which validates
  // WHO you're signing over the funds to, not WHAT you're authorizing them
  // to do once there). `recognizedKey` below closes that: this function
  // now only accepts the exact shapes this project has verified.
  let recognizedKey = false;

  if ("forward" in o) {
    recognizedKey = true;
    const fwd = o.forward;
    if (!fwd || typeof fwd !== "object") {
      throw new Error("Skip's response has an unrecognized forward - refusing to sign.");
    }
    const f = fwd as Record<string, unknown>;
    if (typeof f.receiver !== "string") {
      throw new Error("Skip's response has an unrecognized forward - refusing to sign.");
    }
    // MEDIUM finding from review (2026-08-17, third pass): the "an entry-
    // point contract as a receiver always needs a real instruction
    // attached, otherwise funds are stranded at the contract with no
    // sweep" rule (already enforced for the very first hop, see
    // buildAdapterFromSkipMsg below) wasn't enforced for a NESTED forward
    // landing on an entry point - {"forward":{"receiver":"<entry point>"}}
    // with no `next` passed every check that existed then.
    if (SKIP_ENTRY_POINT_CONTRACT_ADDRESSES.has(f.receiver) && (f.next === undefined || f.next === null)) {
      throw new Error("Skip's response forwards to an entry-point contract with no further instruction - refusing to sign.");
    }
    found.push(f.receiver);
    if (f.next !== undefined && f.next !== null) {
      // PFM's own spec allows `next` to be a JSON string instead of a
      // nested object - if Skip ever emits that form, recursing straight
      // into it (as an object) would silently no-op instead of walking
      // it, so this refuses rather than guess.
      if (typeof f.next !== "object") {
        throw new Error("Skip's response has an unrecognized forward - refusing to sign.");
      }
      found.push(...collectSkipReceivers(f.next));
    }
  }

  if ("wasm" in o) {
    recognizedKey = true;
    const wasm = o.wasm;
    if (!wasm || typeof wasm !== "object") {
      throw new Error("Skip's response has an unrecognized memo - refusing to sign.");
    }
    const w = wasm as Record<string, unknown>;
    // LOW finding from review (2026-08-17, third pass): `recognizedKey`
    // was being set true just from the top-level "wasm" key being
    // present, regardless of whether it actually had a "msg" to recurse
    // into - a memo like {"wasm":{"contract":"..."}} with no "msg" key
    // passed the fail-closed check at the bottom of this function while
    // still contributing nothing to `found`. Same silent-empty-return
    // pattern this rewrite exists to eliminate, one level deeper. Not a
    // theft path (no attacker-controlled address is ever accepted
    // anywhere in this chain), but it reopens the "funds land at the
    // entry-point contract with no sweep" stranding risk for this one
    // specific shape.
    if (!("msg" in w) || !w.msg || typeof w.msg !== "object") {
      throw new Error("Skip's response has an unrecognized memo - refusing to sign.");
    }
    // LOW finding from review (2026-08-17, third pass): `w.contract` -
    // the address ibc-hooks actually calls into - was never collected or
    // checked here at all. Safe today only because chain-side ibc-hooks
    // itself enforces receiver == wasm.contract (verified against
    // Osmosis's x/ibc-hooks source) and errors otherwise - this project's
    // own validator shouldn't depend on that external invariant to stay
    // sound on its own terms.
    if (typeof w.contract !== "string") {
      throw new Error("Skip's response has an unrecognized memo - refusing to sign.");
    }
    found.push(w.contract);
    found.push(...collectSkipReceivers(w.msg));
  }

  if ("swap_and_action" in o) {
    recognizedKey = true;
    found.push(...collectSwapAndActionReceivers(o.swap_and_action));
  }

  if (!recognizedKey) {
    throw new Error("Skip's response has an unrecognized message shape - refusing to sign.");
  }

  return found;
}

function collectSwapAndActionReceivers(swapAndAction: unknown): string[] {
  // `typeof [] === "object"` in JS - Array.isArray() rejected explicitly,
  // not just implied, so an array here (no `post_swap_action` property,
  // same silent-empty-return pattern as elsewhere in this file) can't
  // slip past as if it were a valid map (minor finding, review 2026-08-17,
  // third pass).
  if (!swapAndAction || typeof swapAndAction !== "object" || Array.isArray(swapAndAction)) {
    throw new Error("Skip's response has an unrecognized swap payload - refusing to sign.");
  }
  const sa = swapAndAction as Record<string, unknown>;
  const found: string[] = [];

  // This project never asks Skip to charge its own affiliate cut on this
  // request (fetchSkipMsg below passes no affiliates param at all - the
  // fee is handled entirely by this project's own MsgSend pair further
  // down) - a non-empty affiliates array here means either Skip's API
  // changed shape or the response was tampered with. Every real response
  // this project has captured (2026-08-16/17) returned an empty array.
  // Found in review (2026-08-18, CodeRabbit): a non-array affiliates value
  // (e.g. an object or a string) skipped this check entirely instead of
  // being rejected - safe today only because Skip's own entry-point
  // contract would reject the malformed message on-chain, not because
  // this validator actually caught it.
  if (sa.affiliates !== undefined && !Array.isArray(sa.affiliates)) {
    throw new Error("Skip's response has an unrecognized affiliates list - refusing to sign.");
  }
  if (Array.isArray(sa.affiliates) && sa.affiliates.length > 0) {
    throw new Error("Skip's response includes an unexpected affiliate payout - refusing to sign.");
  }

  const postSwap = sa.post_swap_action;
  // Found in review (2026-08-18, CodeRabbit): `post_swap_action` is
  // required by Skip's own swap_and_action schema (confirmed live,
  // 2026-08-18, against a real ATOM->Terra Classic route) - an absent
  // value used to return `found` as-is instead of rejecting, so a
  // tampered response could drop it and have every address check in this
  // function silently no-op.
  if (postSwap === undefined || !postSwap || typeof postSwap !== "object") {
    throw new Error("Skip's response has an unrecognized post-swap action - refusing to sign.");
  }
  const ps = postSwap as Record<string, unknown>;
  // Skip's real entry-point contract also defines `contract_call` and
  // `hpl_transfer` post-swap actions, both of which deliver funds
  // somewhere this project has no way to validate - reject any key here
  // other than the two shapes actually handled below, instead of silently
  // skipping whatever key it doesn't recognize.
  for (const key of Object.keys(ps)) {
    if (key !== "ibc_transfer" && key !== "transfer") {
      throw new Error(`Skip's response uses an unsupported post-swap action (${key}) - refusing to sign.`);
    }
  }

  const ibcTransfer = ps.ibc_transfer;
  if (ibcTransfer !== undefined) {
    if (!ibcTransfer || typeof ibcTransfer !== "object") {
      throw new Error("Skip's response has an unrecognized ibc_transfer - refusing to sign.");
    }
    const it = ibcTransfer as Record<string, unknown>;
    const ibcInfo = it.ibc_info;
    if (!ibcInfo || typeof ibcInfo !== "object") {
      throw new Error("Skip's response has an unrecognized ibc_transfer - refusing to sign.");
    }
    const info = ibcInfo as Record<string, unknown>;
    if (typeof info.receiver !== "string") {
      throw new Error("Skip's response has an unrecognized ibc_transfer - refusing to sign.");
    }
    // MEDIUM finding from review (2026-08-17, third pass) - same "entry
    // point with no further instruction strands funds" rule as the
    // `forward` branch above: a nested ibc_transfer landing on an entry
    // point with no memo (or a non-string one) passed every check that
    // existed before this.
    if (SKIP_ENTRY_POINT_CONTRACT_ADDRESSES.has(info.receiver) && typeof info.memo !== "string") {
      throw new Error("Skip's response forwards to an entry-point contract with no further instruction - refusing to sign.");
    }
    found.push(info.receiver);
    if (typeof info.recover_address === "string") found.push(info.recover_address);
    if (typeof info.memo === "string") {
      let nested: unknown;
      try {
        nested = JSON.parse(info.memo);
      } catch {
        throw new Error("Skip's response has an unparseable nested memo - refusing to sign.");
      }
      // Found in review (2026-08-18, CodeRabbit): a memo string that
      // parses successfully but to a non-object (e.g. "null", "0", "[]")
      // passed this check (it IS a string) and then collectSkipReceivers
      // silently returned [] for the non-object node - the same
      // entry-point-stranding case the check right above this one exists
      // to reject, just reachable through a valid-JSON detour.
      if (!nested || typeof nested !== "object") {
        throw new Error("Skip's response has an unrecognized nested memo - refusing to sign.");
      }
      found.push(...collectSkipReceivers(nested));
    }
    // Neutron (and any other chain charging its own ack/timeout relay fee
    // via ibc-hooks) swaps a slice of the input into its own fee denom and
    // refunds the leftover here - a real payout position, seen live in the
    // ATOM route (2026-08-16/17), missed by the first version of this
    // function.
    // Found in review (2026-08-18, CodeRabbit): a present-but-malformed
    // fee_swap (not an object, or a refund_address that isn't a string)
    // was silently ignored instead of rejected - fee_swap itself stays
    // optional (not every route charges one), but a present one must have
    // the shape this project actually validates.
    const feeSwap = it.fee_swap;
    if (feeSwap !== undefined) {
      if (!feeSwap || typeof feeSwap !== "object") {
        throw new Error("Skip's response has an unrecognized fee_swap - refusing to sign.");
      }
      const refund = (feeSwap as Record<string, unknown>).refund_address;
      if (typeof refund !== "string") {
        throw new Error("Skip's response has an unrecognized fee_swap - refusing to sign.");
      }
      found.push(refund);
    }
  }

  const transfer = ps.transfer;
  if (transfer !== undefined) {
    if (!transfer || typeof transfer !== "object") {
      throw new Error("Skip's response has an unrecognized transfer - refusing to sign.");
    }
    const to = (transfer as Record<string, unknown>).to_address;
    if (typeof to !== "string") {
      throw new Error("Skip's response has an unrecognized transfer - refusing to sign.");
    }
    // MEDIUM finding from review (2026-08-17, third pass): a plain bank
    // send (this `transfer` action, as opposed to `ibc_transfer`) into a
    // contract is never a legitimate terminal step - there's nothing left
    // to trigger further action once it lands, unlike ibc-hooks. Unlike
    // `forward.receiver`/`ibc_info.receiver` above (which CAN legitimately
    // land on an entry point mid-route, given a further instruction),
    // this position never should - reject outright rather than accept it
    // and rely on the caller's validReceivers-or-entry-point check.
    if (SKIP_ENTRY_POINT_CONTRACT_ADDRESSES.has(to)) {
      throw new Error("Skip's response sends funds to a contract with no further instruction - refusing to sign.");
    }
    found.push(to);
  }

  return found;
}

async function fetchSkipMsg(
  originChainId: string,
  originDenom: string,
  amountIn: bigint,
  route: SkipRoute,
  addressList: string[]
): Promise<SkipMultiChainMsg> {
  const res = await fetch(`${SKIP_API_BASE}/fungible/msgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Everything this project itself already knows and asked for -
      // MEDIUM finding from review (2026-08-17): the previous version
      // echoed these straight back from `route` (Skip's own /route
      // response) instead of the constants/params already in scope at the
      // call site, so a tampered /route response could silently retarget
      // this /msgs request too. `amount_out` and `operations` genuinely
      // have to come from `route` - they're Skip's own computed swap plan,
      // not something this project could know independently - but nothing
      // else needs to.
      source_asset_denom: originDenom,
      source_asset_chain_id: originChainId,
      dest_asset_denom: TERRA_CLASSIC_USDC_DENOM,
      dest_asset_chain_id: TERRA_CLASSIC_CHAIN_ID,
      amount_in: amountIn.toString(),
      amount_out: route.amount_out,
      operations: route.operations,
      slippage_tolerance_percent: "1",
      address_list: addressList,
    }),
  });
  if (!res.ok) throw new Error(`Skip msgs query failed (${res.status})`);
  const body: { msgs: { multi_chain_msg?: SkipMultiChainMsg }[] } = await res.json();
  // Only route shapes this project can sign itself: exactly one Cosmos
  // message, on the origin chain, in one signature. Anything else (a route
  // that genuinely needs multiple separate transactions across chains, an
  // EVM/SVM leg) falls back to the widget instead of guessing - confirmed
  // live for Noble/Cosmos Hub/Osmosis->TC (2026-08-15) that this is the
  // normal shape, but Skip's routing can change over time.
  if (body.msgs.length !== 1 || !body.msgs[0].multi_chain_msg) {
    throw new Error("This route needs more than one transaction - not supported by the direct transfer yet.");
  }
  return body.msgs[0].multi_chain_msg;
}

// Skip's own IBC-hooks/CosmWasm infrastructure does 100% of the actual
// swap - what comes back from /msgs is always ONE already-complete Cosmos
// message (confirmed live 2026-08-15 for both shapes below), never a swap
// message we'd have to build ourselves. This translates it into the
// matching cosmes class - but first checks the fields that determine how
// much of the user's money moves and from whose account against what this
// project itself asked for, since /msgs is a plain unauthenticated HTTP
// response and everything in it would otherwise be signed blindly.
function buildAdapterFromSkipMsg(
  m: SkipMultiChainMsg,
  expected: { sender: string; denom: string; amount: bigint; chainId: string; validReceivers: Set<string> }
): Adapter {
  // Confirms this message is meant to be broadcast on the chain the
  // wallet is actually connected to - Skip's response is a plain
  // unauthenticated HTTP body, so nothing stops it (bug or compromise)
  // from returning a message shaped for a different chain than the one
  // this project asked to route from.
  if (m.chain_id !== expected.chainId) {
    throw new Error("Skip's response targets a different chain - refusing to sign.");
  }
  const parsed = JSON.parse(m.msg);
  if (parsed.sender !== expected.sender) {
    throw new Error("Skip's response doesn't match the connected wallet - refusing to sign.");
  }
  if (m.msg_type_url === "/ibc.applications.transfer.v1.MsgTransfer") {
    if (parsed.token?.denom !== expected.denom || BigInt(parsed.token?.amount ?? "0") !== expected.amount) {
      throw new Error("Skip's response doesn't match the requested amount - refusing to sign.");
    }
    // Two real shapes for the immediate receiver, confirmed against actual
    // broadcast mainnet txs (2026-08-16):
    // - Plain transfer, no swap needed (e.g. Osmosis/Cosmos Hub when the
    //   user already holds USDC there): receiver is a normal account - the
    //   user's pasted Terra Classic address, the origin wallet, or a
    //   recovery address on a chain confirmed safe to derive (addressList
    //   in sendDirectToTerraClassic) - must be in validReceivers directly.
    // - Swap-via-IBC-hooks (e.g. ATOM, which swaps on an intermediate
    //   chain): receiver is that chain's Skip entry-point CONTRACT, not a
    //   wallet address.
    //
    // CRITICAL BUG FOUND IN REVIEW (2026-08-17, blind audit): an earlier
    // version of this check required `parsed.receiver` to equal
    // `memo.wasm.contract` - i.e. the memo's own claim about itself. Both
    // values come from the same untrusted response, so that check can
    // never fail: a forged response with `receiver: "<attacker>"` and
    // `memo: {"wasm":{"contract":"<attacker>"}}` (no `msg` key, so
    // collectSkipReceivers finds nothing to object to either) passed it
    // trivially - on a plain-transfer route that never needed a wasm hook
    // in the first place, this let a compromised/MITM'd response redirect
    // the ENTIRE transfer with no further check anywhere in this
    // function. That's a regression versus the code before this file's
    // memo-forwarding fix - previously every receiver had to be in
    // validReceivers unconditionally. Fixed the only way that actually
    // ties the receiver to something the client itself trusts: the
    // receiver must be one of Skip's own known, stable entry-point
    // contract addresses (SKIP_ENTRY_POINT_CONTRACT_ADDRESSES in
    // onrampConfig.ts, sourced from Skip's own public deployment records -
    // not the memo's own say-so).
    let memoObj: unknown;
    if (parsed.memo) {
      try {
        memoObj = JSON.parse(parsed.memo);
      } catch {
        memoObj = undefined;
      }
    }
    if (SKIP_ENTRY_POINT_CONTRACT_ADDRESSES.has(parsed.receiver)) {
      // MEDIUM finding from review (2026-08-17, second blind-audit pass):
      // this used to only throw if JSON.parse itself threw - an absent/
      // empty memo, or one that parsed to something other than an object
      // (e.g. "0", "null", "[]"), silently passed through with `memoObj`
      // left non-object, and collectSkipReceivers below returns [] for a
      // non-object without complaint. On arrival, ibc-hooks finds no wasm
      // map to route through, so the funds get credited straight to the
      // entry-point contract's own balance - which has no sweep for that.
      // No attacker profit, but a real, unrecoverable loss for the user,
      // triggered by a bug or tamper rather than malice. An entry-point
      // receiver always needs a real, recognized instruction - never
      // nothing (collectSkipReceivers itself now throws below for a
      // present-but-unrecognized one).
      if (!memoObj || typeof memoObj !== "object") {
        throw new Error("Skip's response has no valid instruction for its own entry-point contract - refusing to sign.");
      }
    } else if (!expected.validReceivers.has(parsed.receiver)) {
      throw new Error("Skip's response doesn't match the expected route - refusing to sign.");
    }
    // Everywhere the memo's own forwarding/swap instructions say funds
    // land or bounce back to (every hop after this first one) must be an
    // address this project itself computed OR another of Skip's own
    // entry-point contracts. MEDIUM finding from review (2026-08-17,
    // second pass): a route needing a SECOND swap hop would legitimately
    // land on another chain's entry point here, same trust boundary as
    // the first hop above - this used to only grant that exemption to the
    // first hop, which would have hard-rejected an otherwise-legitimate
    // multi-swap route (not exercised by any route this project has seen
    // live, but not something to leave asymmetric on purpose). Still does
    // NOT validate which pool executes an intermediate swap (that part of
    // the route isn't stable chain-to-chain, see the MsgExecuteContract
    // branch below) - only where the money can end up.
    assertReceiversAllowed(memoObj, expected.validReceivers);
    return new MsgIbcTransfer({
      sourcePort: parsed.source_port,
      sourceChannel: parsed.source_channel,
      token: parsed.token,
      sender: parsed.sender,
      receiver: parsed.receiver,
      // Skip's own value (its server clock, matching the deadlines baked
      // into its memo below), not overridden - this project used to
      // substitute a fresh +10min timestamp here, which desynced from the
      // ~5min deadlines already inside the memo and could let a slow
      // relay pass the outer IBC timeout only to be rejected by the
      // entry-point contract's own expired inner deadline instead of
      // timing out cleanly (found in review, 2026-08-15).
      timeoutTimestamp: BigInt(Math.round(parsed.timeout_timestamp)),
      // Skip's own memo, verbatim - this is what actually carries the
      // swap/forward instructions to the IBC-hooks contracts downstream.
      // Must not be replaced with this project's own memo convention.
      memo: parsed.memo,
      encoding: "",
      useAliasing: false,
    });
  }
  if (m.msg_type_url === "/cosmwasm.wasm.v1.MsgExecuteContract") {
    const funds = parsed.funds as { denom: string; amount: string }[] | undefined;
    if (funds?.length !== 1 || funds[0].denom !== expected.denom || BigInt(funds[0].amount) !== expected.amount) {
      throw new Error("Skip's response doesn't match the requested amount - refusing to sign.");
    }
    // HIGH finding from review (2026-08-17, blind audit): `contract` used
    // to be entirely unchecked here, on the reasoning that "the swap venue
    // isn't stable chain-to-chain" (true, but that's a different address -
    // see below). A tampered response could name any contract on the
    // origin chain with any `msg` body and this project would sign the
    // user's `funds` straight into it. `contract` here is the top-level
    // entry-point contract that RECEIVES the funds directly (confirmed
    // live: the real broadcast Osmosis tx, 2026-08-16, has `contract` set
    // to exactly Skip's own osmosis-1 entry point) - the *unstable* thing
    // is the pool used INSIDE `msg.swap_and_action.user_swap...operations`
    // once execution is already inside that trusted contract, which stays
    // unchecked for the same reason as always. These are different
    // addresses at different trust boundaries - allowlisting the outer one
    // costs nothing extra to maintain.
    if (!SKIP_ENTRY_POINT_CONTRACT_ADDRESSES.has(parsed.contract)) {
      throw new Error("Skip's response targets an unrecognized contract - refusing to sign.");
    }
    // Everywhere the swap's own post_swap_action says funds land or bounce
    // back to (confirmed live against a real broadcast Osmosis tx,
    // 2026-08-16) must be an address this project itself computed, or
    // another of Skip's own entry-point contracts (same reasoning as the
    // MsgTransfer branch above - a second swap hop legitimately lands on
    // another chain's entry point) - same check as that branch, just
    // reading directly off `parsed.msg` instead of a nested `memo` string,
    // since this message type carries the swap instructions as its own
    // body rather than wrapped in a memo.
    // LOW finding from review (2026-08-17, third pass): `parsed.msg` was
    // passed to collectSkipReceivers without checking it's actually an
    // object first - collectSkipReceivers's own top-of-function guard
    // silently returns [] for a non-object node, so a string `msg` would
    // have skipped this whole check. Not exploitable in practice (cosmes's
    // own MsgExecuteContract.toProto() double-JSON-encodes a string `msg`,
    // which the contract can't deserialize on-chain - error, not fund
    // loss), but this validator shouldn't lean on a dependency's
    // serialization behavior to stay sound on its own terms.
    if (!parsed.msg || typeof parsed.msg !== "object") {
      throw new Error("Skip's response has an unrecognized contract message - refusing to sign.");
    }
    assertReceiversAllowed(parsed.msg, expected.validReceivers);
    return new MsgExecuteContract({
      sender: parsed.sender,
      contract: parsed.contract,
      msg: parsed.msg,
      funds: parsed.funds,
    });
  }
  throw new Error(`Unsupported message type from Skip: ${m.msg_type_url}`);
}

// Sends `amount` (in the selected asset's own denom) from the connected
// wallet to `terraClassicAddress`, in a single signature carrying the
// transfer/swap plus 2 MsgSend fee payouts. All 3 amounts come from the
// same typed-once `amount` - there's no separate step where the fee could
// be skipped, it's part of the same signed tx as the transfer itself (see
// project notes, 2026-08-15, on why Skip Go's own chainIdsToAffiliates
// can't be trusted for this).
export async function sendDirectToTerraClassic(
  wallet: ConnectedWallet,
  origin: DirectOriginChain,
  asset: DirectOriginAsset,
  amount: bigint,
  terraClassicAddress: string
) {
  // Belt-and-suspenders - the UI is expected to only ever call this with
  // an already-validated address, but this is the last line of defense
  // before real money moves on a value that ultimately came from a text
  // input.
  if (!isValidTerraClassicAddress(terraClassicAddress)) {
    throw new Error("Not a valid Terra Classic address.");
  }
  // Same belt-and-suspenders reasoning as the address check above - the UI
  // already guards against a dust amount that rounds to 0n (found in
  // review, 2026-08-17), but this is the last check before anything gets
  // signed.
  if (amount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  const { treasuryAddress, treasuryAmount, feeKeeperAddress, feeKeeperAmount, transferAmount } = getDirectFeeSplit(
    origin.chainId,
    amount
  );

  const msgs: Adapter[] = [];

  if (origin.chainId === NOBLE_CHAIN_ID) {
    // Noble -> Terra Classic is a plain IBC transfer with no swap involved
    // - hand-built directly, no need to ask Skip for anything.
    msgs.push(
      new MsgIbcTransfer({
        sourcePort: "transfer",
        sourceChannel: NOBLE_TO_TERRA_CLASSIC_CHANNEL,
        token: { denom: NOBLE_USDC_DENOM, amount: transferAmount.toString() },
        sender: wallet.address,
        receiver: terraClassicAddress,
        timeoutTimestamp: BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n,
        memo: MEMO,
        encoding: "",
        useAliasing: false,
      })
    );
  } else {
    // Everything else needs an actual swap (the selected asset isn't
    // USDC, or is USDC on a chain that still needs to hop through Noble)
    // - ask Skip to route+build it, but sign it ourselves (see
    // buildAdapterFromSkipMsg above) instead of handing it to the widget.
    const route = await fetchSkipRoute(origin.chainId, asset.denom, transferAmount);
    const addressList = route.chain_ids.map((chainId) => {
      // The origin chain is trivially correct - the wallet is already
      // connected there, no derivation needed.
      if (chainId === origin.chainId) return wallet.address;
      // The real destination, pasted by the user - never derived (see
      // isValidTerraClassicAddress above).
      if (chainId === TERRA_CLASSIC_CHAIN_ID) return terraClassicAddress;
      // Any other chain in the route is only ever a recovery address
      // (where funds land if the swap/forward fails mid-route) - safe to
      // derive only for chains confirmed to share the origin wallet's own
      // coin type. Refuses rather than guess for anything else (e.g. if
      // Skip ever routes through Terra 2.0/phoenix-1 again, which is
      // NOT safe to derive this way - same bug class as Terra Classic).
      if (!KNOWN_SLIP44_118_CHAIN_IDS.has(chainId)) {
        throw new Error(`This route passes through an unverified chain (${chainId}) - not supported yet.`);
      }
      const prefix = KNOWN_SLIP44_118_CHAIN_PREFIXES[chainId];
      if (!prefix) throw new Error(`Unknown chain in route: ${chainId}`);
      return deriveAddress(wallet, prefix);
    });
    const skipMsg = await fetchSkipMsg(origin.chainId, asset.denom, transferAmount, route, addressList);
    msgs.push(
      buildAdapterFromSkipMsg(skipMsg, {
        sender: wallet.address,
        denom: asset.denom,
        amount: transferAmount,
        chainId: origin.chainId,
        validReceivers: new Set(addressList),
      })
    );
  }

  // Skipped when an amount rounds to 0 (a fee-free dust transfer) rather
  // than broadcasting a MsgSend for nothing.
  if (treasuryAmount > 0n) {
    msgs.push(
      new MsgSend({
        fromAddress: wallet.address,
        toAddress: treasuryAddress,
        amount: [{ denom: asset.denom, amount: treasuryAmount.toString() }],
      })
    );
  }
  if (feeKeeperAmount > 0n) {
    msgs.push(
      new MsgSend({
        fromAddress: wallet.address,
        toAddress: feeKeeperAddress,
        amount: [{ denom: asset.denom, amount: feeKeeperAmount.toString() }],
      })
    );
  }

  const res = await wallet.broadcastTxSync({ msgs, memo: MEMO });
  if (res.txResponse.code !== 0) {
    throw new Error(res.txResponse.rawLog || "Transaction failed.");
  }
  return { res, transferAmount, treasuryAmount, feeKeeperAmount };
}
