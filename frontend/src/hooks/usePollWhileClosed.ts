import { useEffect } from "react";

// Nothing else refetches once a round/week/raffle stops being "open" - the
// keeper usually reveals within one of its own ~15s poll cycles, but without
// this, a wallet just sitting on the page after buying the closing ticket
// sees "waiting for the winner to be revealed" forever, until some unrelated
// action (or a manual reload) happens to trigger a refetch. Shared by Wheel
// of Repeg, Weekly Round, and Create Your Own Luck instead of tripling the
// same interval in each (found live-testing CYOL, 2026-08-31 - Wheel of
// Repeg and Weekly Round had the identical gap, just less noticeable since
// some other refetch usually fired first by coincidence).
//
// Deliberately narrow (only while `active`) rather than a general-purpose
// polling hook - polling a round that's sitting open waiting for players,
// or one that's already drawn, would just hammer the RPC for no reason.
export function usePollWhileClosed(active: boolean, refetch: () => void, intervalMs = 6000) {
  useEffect(() => {
    if (!active) return;
    const id = setInterval(refetch, intervalMs);
    return () => clearInterval(id);
  }, [active, refetch, intervalMs]);
}
