#!/bin/bash
# Watches a GitHub PR for new CodeRabbit activity and prints one line per
# new item found (safe to pipe into a Monitor tool call - each stdout line
# becomes a notification).
#
# Usage: ./watch-coderabbit-pr.sh <owner/repo> <pr-number> [seen-file]
#
# Ground rules this script exists to enforce (each one caused a real,
# separate failure before this script existed - see the "CodeRabbit PR
# monitoring" note in Obsidian for the full incident history):
#
# 1. GitHub reports the bot's login as "coderabbitai[bot]", WITH the
#    suffix - filtering on the bare "coderabbitai" matches nothing, ever,
#    and fails silently (no error, just permanent silence).
# 2. CodeRabbit's actual line-by-line "actionable" findings live at
#    /pulls/{pr}/comments (inline diff comments) - NOT /issues/{pr}/comments
#    (general PR comments) and NOT /pulls/{pr}/reviews (the review's own
#    summary object). A script that only checks one or two of these three
#    surfaces will miss real findings while looking like it's working.
# 3. NEVER pipe a field containing raw multi-line text (eg. a review's
#    .body, which is markdown with real newlines) into a `while read`
#    loop. `read` consumes one physical line per iteration, so an
#    embedded newline gets treated as a second "record" with garbage/empty
#    fields - this is what caused a real flood of empty
#    "NEW CODERABBIT REVIEW ():" notifications in production use
#    (2026-08-19). This script only ever diffs bare IDs in the loop; full
#    body text is fetched separately, once, only for a genuinely new ID,
#    and is never itself looped over line-by-line.
# 4. Use /bin/sleep, not bare `sleep`, inside a Monitor-tool command
#    specifically - Monitor's shell doesn't reliably inherit the same PATH
#    as a normal Bash tool call, and a missing `sleep` degrades a poll loop
#    into a silent, rate-limit-burning tight loop instead of erroring
#    visibly.
# 5. This repo doesn't get CodeRabbit's free automatic review (fewer than
#    10 GitHub stars) - a fresh PR needs `@coderabbitai review` posted as a
#    comment to get reviewed at all. After that, pushing new commits does
#    NOT reliably get a fresh incremental pass either: `@coderabbitai
#    review` alone can reply "does not re-review already reviewed commits"
#    and do nothing - use `@coderabbitai full review` to force one. Rate
#    limits are NOT a flat number - see CodeRabbit's own Fair Usage Limits
#    Policy (docs.coderabbit.ai/management/plans): a Pro+ plan normally
#    gets 10 reviews/hour, but heavy usage over the trailing 7 days throttles
#    that down (as low as 1/hour "processed one at a time" past ~90
#    reviews in 7 days) - trust the exact wait time CodeRabbit's own
#    rejection message reports, don't recompute it from an assumed rate.

set -u
REPO="${1:?usage: watch-coderabbit-pr.sh <owner/repo> <pr-number> [seen-file]}"
PR="${2:?usage: watch-coderabbit-pr.sh <owner/repo> <pr-number> [seen-file]}"
SEEN="${3:-/tmp/coderabbit-${REPO//\//_}-pr${PR}-seen.txt}"
BOT="coderabbitai[bot]"

: > "$SEEN"

# Silent baseline - record every ID that already exists before this run
# started, so the loop below only ever announces genuinely new activity.
gh api "repos/$REPO/issues/$PR/comments" --jq ".[] | select(.user.login==\"$BOT\") | .id" 2>/dev/null >> "$SEEN"
gh api "repos/$REPO/pulls/$PR/reviews" --jq ".[] | select(.user.login==\"$BOT\") | .id" 2>/dev/null >> "$SEEN"
gh api "repos/$REPO/pulls/$PR/comments" --jq ".[] | select(.user.login==\"$BOT\") | .id" 2>/dev/null >> "$SEEN"

# $1 = API path, $2 = human label for the notification line. Diffs bare
# IDs only (rule #3 above) - never pipes a multi-line field into `read`.
check_new_ids() {
  local endpoint="$1" label="$2"
  gh api "repos/$REPO/$endpoint" --jq ".[] | select(.user.login==\"$BOT\") | .id" 2>/dev/null |
    while read -r id; do
      grep -qx "$id" "$SEEN" && continue
      echo "$id" >> "$SEEN"
      echo "NEW CODERABBIT $label (id=$id) - https://github.com/$REPO/pull/$PR"
    done
}

while true; do
  check_new_ids "issues/$PR/comments" "PR COMMENT"
  check_new_ids "pulls/$PR/reviews" "REVIEW"
  check_new_ids "pulls/$PR/comments" "INLINE FINDING"
  /bin/sleep 30
done
