import { useCallback, useEffect, useState } from "react";
import { getCreatorCooldown, type CreatorCooldownResponse } from "../lib/queryFactory";
import { useLatestRequest } from "./useLatestRequest";

const POLL_MS = 12_000;

export type CyolCreatorCooldownState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; cooldown: CreatorCooldownResponse };

// Polls GetCreatorCooldown live while `active` (the safety checklist only
// needs this before a raffle's outcome is settled) - a creator could in
// theory start a new raffle elsewhere while this page is open, and the
// cooldown state is otherwise invisible to a player deciding whether to buy
// a ticket here. Same useLatestRequest guard as the other data hooks, in
// case `creator` itself ever changes mid-flight.
export function useCyolCreatorCooldown(creator: string, active: boolean): CyolCreatorCooldownState {
  const [state, setState] = useState<CyolCreatorCooldownState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  const load = useCallback(async () => {
    const token = start();
    try {
      const cooldown = await getCreatorCooldown(creator);
      if (isCurrent(token)) setState({ status: "loaded", cooldown });
    } catch {
      if (isCurrent(token)) setState({ status: "error" });
    }
  }, [creator, start, isCurrent]);

  useEffect(() => {
    if (!active) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  return state;
}
