import { queryContract } from "@goblinhunt/cosmes/client";
import { RPC } from "./chainConfig";
import { CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS } from "./deployment";

// Mirrors contracts/create-your-own-luck-factory/src/msg.rs's
// RaffleRecordResponse/RafflesResponse exactly.
export type RaffleRecordResponse = {
  index: number;
  address: string;
  creator: string;
  created_at: number;
};

export type RafflesResponse = {
  raffles: RaffleRecordResponse[];
  total_count: number;
};

// Newest-first, paginated - see the factory's GetRaffles doc comment.
// start_after is the index of the last record already seen, not a raffle
// address; pass the previous response's last raffle's index to continue.
export function getRaffles(
  startAfter?: number,
  limit?: number,
  contractAddress: string = CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS
) {
  return queryContract<RafflesResponse>(RPC, {
    address: contractAddress,
    query: {
      get_raffles: {
        start_after: startAfter ?? null,
        limit: limit ?? null,
      },
    },
  });
}

export type CreatorCooldownResponse = {
  unsafe_streak: number;
  // Unix seconds. Null only if this wallet has never created an unsafe-
  // shaped raffle - NOT re-checked for staleness by the query itself
  // (round-12 audit fix, mirrors the same correction already made on the
  // factory's own GetCreatorCooldown doc comment, msg.rs, round 11).
  // cyolChecklist.ts re-derives staleness client-side from this raw value.
  next_unsafe_allowed_at: number | null;
};

export function getCreatorCooldown(
  creator: string,
  contractAddress: string = CREATE_YOUR_OWN_LUCK_FACTORY_ADDRESS
) {
  return queryContract<CreatorCooldownResponse>(RPC, {
    address: contractAddress,
    query: { get_creator_cooldown: { creator } },
  });
}

// Mirrors the factory's IsCw20Whitelisted/IsCw20Blacklisted queries exactly
// (contracts/create-your-own-luck-factory/src/msg.rs) - used by
// RaffleDetailPage.tsx to mirror execute_cancel_raffle's own
// cancellation_penalty_waived_by_platform_revocation waiver (round-10 audit
// fix, found independently by two reviewers): a CW20-prized raffle that's
// still Funding with nothing deposited, whose token got blacklisted or
// de-whitelisted out from under the creator, pays a 0 penalty on-chain -
// without this, the frontend's cancel warning showed a nonzero forfeit the
// contract would never actually charge.
export function getCw20Whitelisted(cw20Address: string, factoryAddress: string) {
  return queryContract<boolean>(RPC, {
    address: factoryAddress,
    query: { is_cw20_whitelisted: { address: cw20Address } },
  });
}

export function getCw20Blacklisted(cw20Address: string, factoryAddress: string) {
  return queryContract<boolean>(RPC, {
    address: factoryAddress,
    query: { is_cw20_blacklisted: { address: cw20Address } },
  });
}
