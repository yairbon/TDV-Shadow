#!/usr/bin/env bash
# PreCompact hook.
# Re-injects the load-bearing coordinate-transformation math into the post-compaction
# context so the summarizer cannot lossily paraphrase the equations.
#
# Contract: stdin = hook JSON payload (ignored). stdout = additionalContext.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MATH_FILE="$ROOT/docs/RENDER_ALGORITHMS.md"

emit() {
  # jq-free JSON string escaping: backslashes, quotes, newlines, tabs, CR.
  python3 - "$1" <<'PY'
import json, sys
body = sys.argv[1]
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreCompact",
        "additionalContext": body,
    }
}))
PY
}

if [[ ! -f "$MATH_FILE" ]]; then
  emit "PRESERVED (compaction-critical): docs/RENDER_ALGORITHMS.md is MISSING. Recreate it before writing renderer code; do not re-derive coordinate math from memory."
  exit 0
fi

# Extract only the fenced "MATH-CRITICAL" block(s) — the whole file is too large to
# re-inject on every compaction.
BODY="$(awk '
  /<!-- MATH-CRITICAL:BEGIN -->/ { keep=1; next }
  /<!-- MATH-CRITICAL:END -->/   { keep=0; next }
  keep { print }
' "$MATH_FILE")"

if [[ -z "${BODY// }" ]]; then
  BODY="$(head -c 4000 "$MATH_FILE")"
fi

emit "PRESERVED ACROSS COMPACTION — canonical coordinate transforms (verbatim from docs/RENDER_ALGORITHMS.md). These equations are normative; do not paraphrase, re-derive, or 'simplify' them:

$BODY"
exit 0
