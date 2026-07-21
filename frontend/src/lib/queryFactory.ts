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
