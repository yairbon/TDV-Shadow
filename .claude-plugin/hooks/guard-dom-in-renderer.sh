#!/usr/bin/env bash
# PreToolUse hook: enforce root mandate #1 — no DOM manipulation inside the renderer.
# Blocks the write (exit 2) with a one-line reason. Silent otherwise.
set -uo pipefail

PARSED="$(python3 -c '
import base64, json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input") or {}
path = ti.get("file_path") or ""
body = ti.get("content") or ti.get("new_string") or ""
edits = ti.get("edits")
if not body and isinstance(edits, list):
    body = "\n".join(str(e.get("new_string", "")) for e in edits)
sys.stdout.write(path + "\t" + base64.b64encode(body.encode()).decode())
')"

FILE="${PARSED%%$'\t'*}"
B64="${PARSED#*$'\t'}"

[[ -z "$FILE" || "$FILE" == "$PARSED" ]] && exit 0
case "$FILE" in
  src/renderer/*|*/src/renderer/*) ;;
  *) exit 0 ;;
esac

BODY="$(printf '%s' "$B64" | base64 -d 2>/dev/null)"
[[ -z "${BODY// }" ]] && exit 0

# Allow the canvas element handle itself; forbid element construction / DOM mutation.
if grep -Eq 'document\.(createElement|body|querySelector)|\.innerHTML|\.appendChild|\.insertAdjacentHTML|\.style\.(left|top|width|height)[[:space:]]*=' <<<"$BODY"; then
  echo "Blocked: DOM manipulation in src/renderer (root CLAUDE.md mandate #1). Chart primitives must be drawn on the canvas context, not built as elements. Put element work in src/ui/." >&2
  exit 2
fi
exit 0
