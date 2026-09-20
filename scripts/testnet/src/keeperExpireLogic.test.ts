// Real tests for nextExpireAction, run directly (no test framework wired
// into scripts/testnet/ yet - `npx tsx src/keeperExpireLogic.test.ts`,
// throws + non-zero exit on any failure). Boundary values below are chosen
// to match the exact >=/< conditions the real Rust contracts use (see
// keeperExpireLogic.ts's own comment for which contract.rs/execute.rs files
// these were verified against), not arbitrary round numbers.

import assert from "node:assert/strict";
import {
  nextExpireAction,
  EXPIRE_FINALIZE_DELAY_BLOCKS,
  EXPIRE_CHALLENGE_BLOCKS,
  REVEAL_PRIORITY_MARGIN_BLOCKS,
  REQUEST_EXPIRE_TTL_BLOCKS,
} from "./keeperExpireLogic";

const MAX_REVEAL_AGE_SECONDS = 3600;
const BASE_HEIGHT = 1_000_000;
const CLOSED_AT = 10_000_000;

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- closed: request_expire gate (time-based) ---

test("closed, reveal-age window still open -> waits", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS - 1,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {},
  });
  assert.equal(action, null);
});

test("closed, reveal-age window exactly elapsed, no prior attempt -> request_expire", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {},
  });
  assert.equal(action, "request_expire");
});

test("closed, closedAtSeconds null (defensive) -> waits, never throws", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: null,
    nowSeconds: CLOSED_AT + 999_999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {},
  });
  assert.equal(action, null);
});

// --- closed: finalize_expire gate (height-based, after a request attempt) ---

test("closed, requested < EXPIRE_FINALIZE_DELAY_BLOCKS ago -> waits (this was the real bug: old code tried finalize the same tick as request)", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS + 999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: { requestAttemptHeight: BASE_HEIGHT - 1 }, // 1 block ago
  });
  assert.equal(action, null);
});

test("closed, requested exactly EXPIRE_FINALIZE_DELAY_BLOCKS ago, no finalize attempt yet -> finalize_expire", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS + 999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: { requestAttemptHeight: BASE_HEIGHT - EXPIRE_FINALIZE_DELAY_BLOCKS },
  });
  assert.equal(action, "finalize_expire");
});

test("closed, finalize gate open but finalize was already retried recently -> waits (don't hammer finalize either)", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS + 999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {
      requestAttemptHeight: BASE_HEIGHT - 150,
      finalizeAttemptHeight: BASE_HEIGHT - 5, // retried very recently
    },
  });
  assert.equal(action, null);
});

test("closed, finalize gate open (request still within TTL) and finalize retry cooldown elapsed -> finalize_expire again", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS + 999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {
      requestAttemptHeight: BASE_HEIGHT - 150, // sinceRequest=150: >=100, <200 TTL - still live
      finalizeAttemptHeight: BASE_HEIGHT - EXPIRE_FINALIZE_DELAY_BLOCKS, // sinceFinalize=100: cooldown elapsed
    },
  });
  assert.equal(action, "finalize_expire");
});

test("closed, request went stale (TTL elapsed) without finalize ever succeeding -> re-request", () => {
  const action = nextExpireAction({
    status: "closed",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + MAX_REVEAL_AGE_SECONDS + 999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: { requestAttemptHeight: BASE_HEIGHT - REQUEST_EXPIRE_TTL_BLOCKS }, // exactly at TTL boundary
  });
  assert.equal(action, "request_expire");
});

// --- expiry_pending: claim_expire gate ---

test("expiry_pending, no local finalize anchor (missing state) -> tries claim_expire once as fallback", () => {
  const action = nextExpireAction({
    status: "expiry_pending",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + 999_999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {},
  });
  assert.equal(action, "claim_expire");
});

test("expiry_pending, challenge window still open -> waits", () => {
  const action = nextExpireAction({
    status: "expiry_pending",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + 999_999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: { finalizeAttemptHeight: BASE_HEIGHT - 1 },
  });
  assert.equal(action, null);
});

test("expiry_pending, challenge window exactly elapsed, no claim attempt yet -> claim_expire", () => {
  const action = nextExpireAction({
    status: "expiry_pending",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + 999_999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: { finalizeAttemptHeight: BASE_HEIGHT - (EXPIRE_CHALLENGE_BLOCKS + REVEAL_PRIORITY_MARGIN_BLOCKS) },
  });
  assert.equal(action, "claim_expire");
});

test("expiry_pending, challenge window elapsed but claim was already retried recently -> waits", () => {
  const action = nextExpireAction({
    status: "expiry_pending",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + 999_999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {
      finalizeAttemptHeight: BASE_HEIGHT - 500,
      claimAttemptHeight: BASE_HEIGHT - 5,
    },
  });
  assert.equal(action, null);
});

test("expiry_pending, claim retry cooldown elapsed -> claim_expire again", () => {
  const action = nextExpireAction({
    status: "expiry_pending",
    closedAtSeconds: CLOSED_AT,
    nowSeconds: CLOSED_AT + 999_999,
    maxRevealAgeSeconds: MAX_REVEAL_AGE_SECONDS,
    currentHeight: BASE_HEIGHT,
    phase: {
      finalizeAttemptHeight: BASE_HEIGHT - 500,
      claimAttemptHeight: BASE_HEIGHT - EXPIRE_CHALLENGE_BLOCKS,
    },
  });
  assert.equal(action, "claim_expire");
});

console.log(`\n${passed} passed, 0 failed`);
