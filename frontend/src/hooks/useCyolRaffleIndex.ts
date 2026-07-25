import { useEffect, useState } from "react";
import { getRaffles } from "../lib/queryFactory";

// The detail page only knows a raffle's address (from the URL), but the
// factory's only lookup is GetRaffles (paginated by index, newest-first) -
// there's no "index for this address" query. A single request for the 100
// newest covers the platform's real scale today; if a raffle's index isn't
// found in that page, this just shows nothing rather than paginating
// further - purely cosmetic, not worth a contract change or a crawl loop.
export function useCyolRaffleIndex(address: string): number | null {
  const [index, setIndex] = useState<number | null>(null);

  useEffect(() => {
    setIndex(null);
    getRaffles(undefined, 100)
      .then((res) => {
        const match = res.raffles.find((r) => r.address === address);
        setIndex(match?.index ?? null);
      })
      .catch(() => setIndex(null));
  }, [address]);

  return index;
}
