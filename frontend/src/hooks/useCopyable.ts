import { useState } from "react";

// 4th copy of this exact pattern (VerifyRoundPanel/WeeklyVerifyRoundPanel/
// CyolVerifyPanel each had their own inline copy) - extracted here rather
// than duplicated again, but those 3 existing ones are left as-is (not
// worth the churn of migrating working code to this just to remove
// duplication that already existed).
export function useCopyable() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      },
      // writeText rejects on an insecure context, an unfocused document, or
      // a denied permission - without this the button silently never shows
      // "Copied" and the rejection goes unhandled (found in CodeRabbit
      // review, PR #48).
      (err) => {
        console.error(err);
      }
    );
  }
  return { copiedKey, copy };
}
