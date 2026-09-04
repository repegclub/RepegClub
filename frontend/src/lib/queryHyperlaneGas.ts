import { queryContract } from "@goblinhunt/cosmes/client";

// Hyperlane's mailbox on Terra Classic mainnet, shared by every warp route
// (LUNC/USTC/JURIS all dispatch through this same one) - confirmed live
// 2026-09-04 by reading the LUNC warp contract's own raw storage state (no
// QueryMsg on the warp contract exposes its mailbox address directly).
const TERRA_CLASSIC_MAILBOX = "terra1fwg35n5esjgny7d8pxnz8usjpwsvpguk0txsy6cnqxy58x9fdlksjpx3p9";

// 32 zero bytes - a placeholder recipient_addr/msg_body for the quote-only
// query below. Traced through the real contracts (mailbox -> required hook,
// a merkle-tree hook that quotes a flat 0 -> default hook, the IGP, whose
// gas_limit is resolved from dest_domain alone when metadata is empty,
// never from message content) and confirmed live: querying with this
// placeholder reproduces the same numbers as querying with a real recipient
// and body. So the quote can be fetched before the user has entered a
// destination address at all.
const PLACEHOLDER_RECIPIENT = "00".repeat(32);

// Live-quotes the exact uluna needed right now to dispatch a
// transfer_remote through `warpContract` to `destDomain` - replaces the
// hardcoded HyperlaneDestination.igpFeeUluna constants removed 2026-09-04
// (audit round, docs/audit-prompts/hyperlane-outbound-onramp/round-01-
// findings-opus.md, Finding 3): those were measured once and drifted,
// silently burning ~288-455 LUNC per transfer (paid into Hyperlane's
// aggregate hook, which has no refund path - confirmed reading the real
// hook source, `// do nothing` after forwarding each sub-hook its exact
// quote) whenever the live price moved below the hardcoded number. A
// stale-too-LOW number just fails the tx safely instead (confirmed
// separately, Finding 4) - so this only needs to get close, not exact.
export async function quoteHyperlaneGasFee(rpc: string, warpContract: string, destDomain: number): Promise<bigint> {
  const res = await queryContract<{ fees: { denom: string; amount: string }[] }>(rpc, {
    address: TERRA_CLASSIC_MAILBOX,
    query: {
      hook: {
        quote_dispatch: {
          sender: warpContract,
          msg: {
            dest_domain: destDomain,
            recipient_addr: PLACEHOLDER_RECIPIENT,
            msg_body: PLACEHOLDER_RECIPIENT,
            hook: null,
            metadata: null,
          },
        },
      },
    },
  });
  const ulunaFee = res.fees.find((c) => c.denom === "uluna");
  if (!ulunaFee) throw new Error("Hyperlane gas quote didn't return a uluna fee.");
  return BigInt(ulunaFee.amount);
}
