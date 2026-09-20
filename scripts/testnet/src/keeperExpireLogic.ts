// Pure decision logic for the 3-phase expiration cascade (Request/Finalize/
// Claim) - factored out of keeperMainnet.ts so it can be imported by a test
// file without triggering that file's unconditional `main()` call at module
// scope (same reason keeperTargets.ts/keeperState.ts are their own files -
// see keeperTargets.ts's top comment).

export type ExpireAction = "request_expire" | "finalize_expire" | "claim_expire";

export interface ExpirePhaseState {
  // Only set when request_expire actually succeeded on-chain - this is the
  // real anchor finalize's gate/TTL are computed from. A failed/errored
  // attempt must NOT set this (CodeRabbit finding, 2026-09-20 review, sixth
  // round - the first version of this file set it unconditionally after
  // every attempt, so a single failed request made the keeper wait out the
  // full finalize-delay window and then try finalize_expire against a
  // request that never actually landed, which the contract always rejects -
  // worse than just retrying request_expire).
  requestSucceededHeight?: number;
  // Set on every request_expire attempt regardless of outcome - retry
  // cooldown only, so a repeatedly-failing attempt doesn't hammer every
  // ~15s tick either.
  lastRequestAttemptHeight?: number;
  // Same request/finalize split, applied to finalize_expire too
  // (CodeRabbit finding, 2026-09-20 review, eleventh round) - the previous
  // version reasoned finalize's success was safely observable via the
  // status field alone, which is true for THIS tick's decision, but not for
  // the value persisted for claim's gate: a failed finalize attempt's
  // height could still get read as the anchor if the keeper never observes
  // a later successful attempt cleanly (process restart, or a rejected
  // retry landing right before the real one that finally succeeds).
  // finalizeSucceededHeight is the real anchor for claim's gate; the caller
  // (keeperMainnet.ts) also sets it conservatively from the first tick it
  // observes expiry_pending with no local record, instead of trying
  // claim_expire immediately.
  finalizeSucceededHeight?: number;
  // Set on every finalize_expire attempt regardless of outcome - retry
  // cooldown only, same reasoning as lastRequestAttemptHeight.
  lastFinalizeAttemptHeight?: number;
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
    if (phase.requestSucceededHeight !== undefined) {
      const sinceRequest = currentHeight - phase.requestSucceededHeight;
      if (sinceRequest < EXPIRE_FINALIZE_DELAY_BLOCKS) return null; // finalize gate not open yet
      if (sinceRequest < REQUEST_EXPIRE_TTL_BLOCKS) {
        // Gate open, request still live - but don't hammer finalize every
        // tick either if it keeps failing for some other reason.
        if (
          phase.lastFinalizeAttemptHeight !== undefined &&
          currentHeight - phase.lastFinalizeAttemptHeight < EXPIRE_FINALIZE_DELAY_BLOCKS
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
    if (!timeGateOpen) return null;
    // Don't hammer request_expire every tick if it keeps failing (e.g. a
    // transient RPC error) - same retry-cooldown reasoning as finalize/claim
    // below.
    if (
      phase.lastRequestAttemptHeight !== undefined &&
      currentHeight - phase.lastRequestAttemptHeight < EXPIRE_FINALIZE_DELAY_BLOCKS
    ) {
      return null;
    }
    return "request_expire";
  }

  // expiry_pending - by the time status genuinely shows this (a live query,
  // not our own bookkeeping), finalize_expire really did succeed on-chain.
  // The caller sets finalizeSucceededHeight conservatively (to the current
  // height) the first tick it observes this status with no local record, so
  // this should never actually be undefined here in practice - the
  // fallback below is defense-in-depth, not the expected path.
  if (phase.finalizeSucceededHeight !== undefined) {
    const sinceFinalize = currentHeight - phase.finalizeSucceededHeight;
    if (sinceFinalize < EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS) return null;
  }
  // Retry cooldown uses the same full window as the gate above (CodeRabbit
  // finding, 2026-09-20 review, eleventh round - this used to be just
  // EXPIRE_CHALLENGE_BLOCKS, shorter than the real contract requirement),
  // so a retry never fires before the genuine on-chain window has elapsed.
  if (
    phase.claimAttemptHeight !== undefined &&
    currentHeight - phase.claimAttemptHeight < EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS
  ) {
    return null;
  }
  return "claim_expire";
}
