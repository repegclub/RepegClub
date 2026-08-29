// Friendly translations for the 3-phase outage rescue (Request/Finalize/
// Claim) added in v9 - see lib/roundActions.ts. Scoped to just this new
// mechanism (unlike cyolErrorMessages.ts's full-file coverage) because every
// other Wheel Manager/Weekly Round action already shows its raw rawLog with
// no translation layer at all - this only exists because these specific
// errors are brand new with no precedent for a player to have seen before.
// Shared between wheel-manager (round_id) and weekly-round (week_id) since
// contracts/wheel-manager/src/error.rs and contracts/weekly-round/src/error.rs
// use identical text modulo "Round"/"Week" - matched case-insensitively so
// one rule covers both.
const RULES: { test: RegExp; friendly: string }[] = [
  { test: /reveal is not overdue yet/i, friendly: "This isn't stuck long enough yet to rescue — check back later." },
  { test: /is not next in the reveal queue/i, friendly: "An earlier round/week is still waiting to be resolved first — try that one instead." },
  { test: /expiration request is already pending/i, friendly: "A rescue request is already in progress." },
  { test: /no expiration request is pending/i, friendly: "Request the rescue first, before trying to finalize it." },
  { test: /expiration request .* has expired/i, friendly: "The rescue request expired — request it again." },
  { test: /expiration request has not cleared its finalize delay yet/i, friendly: "Not ready to finalize yet — try again in a few minutes." },
  { test: /is not ExpiryPending/i, friendly: "This isn't ready to claim yet." },
  { test: /challenge window is still open/i, friendly: "Not ready to claim yet — a legitimate reveal can still land, try again shortly." },
  { test: /is not (Closed|Open|drawn)\b/i, friendly: "This isn't in the right state for that action anymore — it may have already been resolved." },
];

export function friendlyRoundError(raw: string): string {
  const match = RULES.find((rule) => rule.test.test(raw));
  return match ? match.friendly : raw;
}
