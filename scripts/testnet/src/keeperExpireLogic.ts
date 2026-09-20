// Pure decision logic for the 3-phase expiration cascade (Request/Finalize/
// Claim) - factored out of keeperMainnet.ts so it can be imported by a test
// file without triggering that file's unconditional `main()` call at module
// scope (same reason keeperTargets.ts/keeperState.ts are their own files -
// see keeperTargets.ts's top comment).

export type ExpireAction = "request_expire" | "finalize_expire" | "claim_expire";

export interface ExpirePhaseState {
  requestAttemptHeight?: number;
  finalizeAttemptHeight?: number;
  claimAttemptHeight?: number;
}

// Real on-chain block-height gates for the 3-phase expiration cascade -
// identical across all 3 contracts, verified against contracts/wheel-manager,
// contracts/weekly-round, and contracts/create-your-own-luck's execute.rs
// (not guessed - each has its own EXPIRE_FINALIZE_DELAY_BLOCKS/
// EXPIRE_CHALLENGE_BLOCKS/REVEAL_PRIORITY_MARGIN_BLOCKS/
// REQUEST_EXPIRE_TTL_BLOCKS constant with these exact values).
export const EXPIRE_FINALIZE_DELAY_BLOCKS = 100;
export const EXPIRE_CHALLENGE_BLOCKS = 100;
export const REVEAL_PRIORITY_MARGIN_BLOCKS = 20;
export const REQUEST_EXPIRE_TTL_BLOCKS = 200;

/**
 * Decides which single expiration action (if any) is worth attempting this
 * tick for a Closed/ExpiryPending round/week/raffle. Pure function, no I/O -
 * see keeperExpireLogic.test.ts for its test coverage.
 *
 * Replaces the old approach of trying request_expire AND finalize_expire
 * together on every tick regardless of timing, relying on the contract to
 * reject early attempts (CodeRabbit finding, 2026-09-19 review, fifth round)
 * - repeated rejected transactions still cost real gas. None of the
 * contracts expose `expire_requested_at_height`/`expiry_pending_since_height`
 * via any query, so this tracks the height of the keeper's OWN last attempt
 * of each phase locally (see keeperState.ts's expirePhases) and only
 * attempts the next phase once enough blocks have passed since that local
 * anchor. Self-healing if the local record is missing or stale (falls back
 * to a bounded retry cooldown instead of hammering every ~15s tick) rather
 * than perfectly precise, since the real anchor height genuinely isn't
 * observable from outside the contract.
 */
export function nextExpireAction(input: {
  status: "closed" | "expiry_pending";
  closedAtSeconds: number | null;
  nowSeconds: number;
  maxRevealAgeSeconds: number;
  currentHeight: number;
  phase: ExpirePhaseState;
}): ExpireAction | null {
  const { status, closedAtSeconds, nowSeconds, maxRevealAgeSeconds, currentHeight, phase } = input;

  if (status === "closed") {
    if (phase.requestAttemptHeight !== undefined) {
      const sinceRequest = currentHeight - phase.requestAttemptHeight;
      if (sinceRequest < EXPIRE_FINALIZE_DELAY_BLOCKS) return null; // finalize gate not open yet
      if (sinceRequest < REQUEST_EXPIRE_TTL_BLOCKS) {
        // Gate open, request still live - but don't hammer finalize every
        // tick either if it keeps failing for some other reason.
        if (
          phase.finalizeAttemptHeight !== undefined &&
          currentHeight - phase.finalizeAttemptHeight < EXPIRE_FINALIZE_DELAY_BLOCKS
        ) {
          return null;
        }
        return "finalize_expire";
      }
      // Request went stale (TTL elapsed) without finalize succeeding - the
      // contract itself requires a fresh request at this point
      // (ExpireRequestExpired), so fall through to re-request below.
    }
    if (closedAtSeconds === null) return null; // defensive - shouldn't happen for a genuinely Closed item
    const timeGateOpen = nowSeconds >= closedAtSeconds + maxRevealAgeSeconds;
    return timeGateOpen ? "request_expire" : null;
  }

  // expiry_pending
  if (phase.finalizeAttemptHeight !== undefined) {
    const sinceFinalize = currentHeight - phase.finalizeAttemptHeight;
    if (sinceFinalize < EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS) return null;
  }
  // A missing finalizeAttemptHeight means the local record is missing
  // (keeper restart, or another caller triggered the transition) - try
  // once, gated only by claim's own retry cooldown below.
  if (phase.claimAttemptHeight !== undefined && currentHeight - phase.claimAttemptHeight < EXPIRE_CHALLENGE_BLOCKS) {
    return null;
  }
  return "claim_expire";
}
