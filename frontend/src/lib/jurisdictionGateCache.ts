// Tracks, per browser, whether the visitor has already acknowledged the
// jurisdiction/age gate (see JurisdictionGateModal.tsx) - shown once before
// the first ticket purchase across Wheel of Repeg, Weekly Round, and Create
// Your Own Luck, then remembered so it doesn't interrupt every later
// purchase. Not tied to a wallet or contract - it's the same acknowledgement
// regardless of which product or address is involved.
const KEY = "repegclub:jurisdiction-gate-acked";

export function hasAckedJurisdictionGate(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function ackJurisdictionGate(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Best-effort only - localStorage can be unavailable (private browsing).
  }
}
