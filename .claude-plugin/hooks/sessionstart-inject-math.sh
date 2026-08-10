#!/usr/bin/env bash
# SessionStart hook (matchers: startup, clear, compact).
#
# This is the hook that actually preserves the coordinate math across a context wipe:
# SessionStart supports hookSpecificOutput.additionalContext, and its `compact` matcher
# fires immediately after a compaction. It reads the snapshot staged by PreCompact, and
# falls back to reading docs/RENDER_ALGORITHMS.md directly (covers `clear` and `startup`,
# where no PreCompact ran).
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MATH_FILE="$ROOT/docs/RENDER_ALGORITHMS.md"
SNAPSHOT="$ROOT/.claude/.math-snapshot.md"

extract() {
  awk '
    /MATH-CRITICAL:BEGIN/ { keep=1; next }
    /MATH-CRITICAL:END/   { keep=0; next }
    keep { print }
  ' "$1"
}

BODY=""
if [[ -f "$MATH_FILE" ]]; then
  BODY="$(extract "$MATH_FILE")"
fi
if [[ -z "${BODY// }" && -f "$SNAPSHOT" ]]; then
  BODY="$(cat "$SNAPSHOT")"
fi
# Nothing to say -> stay silent rather than inject a useless warning.
[[ -z "${BODY// }" ]] && exit 0

python3 -c '
import json, sys
body = sys.stdin.read()
preamble = (
  "TDV-Shadow canonical coordinate transforms, re-injected verbatim from "
  "docs/RENDER_ALGORITHMS.md. These equations are normative: implement them exactly, "
  "do not paraphrase or re-derive them from memory, and import them from "
  "src/renderer/scale/ rather than inlining a copy.\n\n"
)
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": preamble + body,
  }
}))
' <<<"$BODY"
exit 0
