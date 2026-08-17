import { MsgExecuteContract, MsgIbcTransfer, MsgSend, type Adapter } from "@goblinhunt/cosmes/client";
import { bech32, resolveBech32Address } from "@goblinhunt/cosmes/codec";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import {
  KNOWN_SLIP44_118_CHAIN_IDS,
  NOBLE_CHAIN_ID,
  NOBLE_USDC_DENOM,
  NOBLE_TO_TERRA_CLASSIC_CHANNEL,
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

// Cache: Skip's own chain registry - used to look up the bech32 prefix of
// whatever intermediate chain a quoted route happens to pass through
// (recovery addresses only - see sendDirectToTerraClassic below). Fetched
// once and reused rather than hardcoding a prefix map: which chain a
// Cosmos Hub/Osmosis swap lands on isn't stable (confirmed live 2026-08-15
// - core-1, neutron-1, phoenix-1 seen across separate checks the same
// day), so a fixed list would go stale.
let skipChainPrefixesCache: Promise<Record<string, string>> | null = null;
function getSkipChainPrefixes(): Promise<Record<string, string>> {
  if (!skipChainPrefixesCache) {
    skipChainPrefixesCache = fetch(`${SKIP_API_BASE}/info/chains`)
      .then((res) => {
        if (!res.ok) throw new Error(`Skip chain list query failed (${res.status})`);
        return res.json();
      })
      .then((body: { chains: { chain_id: string; bech32_prefix: string }[] }) =>
        Object.fromEntries(body.chains.map((c) => [c.chain_id, c.bech32_prefix]))
      )
      .catch((err) => {
        // Don't cache a failed lookup - retry on the next call instead of
        // permanently breaking every direct transfer for the rest of the
        // session on one transient network error.
        skipChainPrefixesCache = null;
        throw err;
      });
  }
  return skipChainPrefixesCache;
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

async function fetchSkipMsg(route: SkipRoute, addressList: string[]): Promise<SkipMultiChainMsg> {
  const res = await fetch(`${SKIP_API_BASE}/fungible/msgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_asset_denom: route.source_asset_denom,
      source_asset_chain_id: route.source_asset_chain_id,
      dest_asset_denom: route.dest_asset_denom,
      dest_asset_chain_id: route.dest_asset_chain_id,
      amount_in: route.amount_in,
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
    // The immediate receiver on this first hop must be one of the
    // addresses this project itself computed for the route (the user's
    // pasted Terra Classic address, the origin wallet, or a recovery
    // address on a chain confirmed safe to derive - see addressList in
    // sendDirectToTerraClassic) - not just anything Skip happens to send
    // back. This does NOT validate the deeper forwarding instructions
    // packed into `memo` below (Skip's own IBC-hooks/PFM format, which
    // this project doesn't parse) - a compromised Skip response could
    // still misdirect funds after this first hop by way of the memo.
    // Known gap, not closed here.
    if (!expected.validReceivers.has(parsed.receiver)) {
      throw new Error("Skip's response doesn't match the expected route - refusing to sign.");
    }
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
    // Unlike MsgTransfer above, `contract`/`msg` aren't checked against an
    // allowlist - the swap venue Skip routes through isn't stable (seen
    // landing on core-1, neutron-1, and phoenix-1 across separate checks
    // the same day, 2026-08-15), so a fixed pool-contract allowlist would
    // need active upkeep this project doesn't do yet. sender/funds are
    // still confirmed above, so this can't move a different amount or
    // denom than requested, but the specific contract call is trusted as
    // Skip returns it. Known gap, not closed here.
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
    const prefixes = await getSkipChainPrefixes();
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
      const prefix = prefixes[chainId];
      if (!prefix) throw new Error(`Unknown chain in route: ${chainId}`);
      return deriveAddress(wallet, prefix);
    });
    const skipMsg = await fetchSkipMsg(route, addressList);
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
