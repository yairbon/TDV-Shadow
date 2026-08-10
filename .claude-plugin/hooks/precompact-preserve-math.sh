#!/usr/bin/env bash
# PreCompact hook.
#
# IMPORTANT: PreCompact CANNOT inject context. Per the hooks reference it supports only
# `decision: "block"` (+ reason) and exit code 2 to abort compaction — hookSpecificOutput
# .additionalContext is ignored for this event. Re-injection is therefore done by the
# SessionStart hook (matcher: compact), which DOES support additionalContext.
#
# This hook's job is the half PreCompact can actually do:
#   1. Verify the canonical math doc exists and still carries its MATH-CRITICAL markers.
#   2. Stage a verbatim snapshot of that block to disk, so the post-compaction
#      SessionStart hook has something guaranteed-current to re-inject.
#   3. Block compaction outright if the math would be lost with no way to restore it.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MATH_FILE="$ROOT/docs/RENDER_ALGORITHMS.md"
SNAPSHOT="$ROOT/.claude/.math-snapshot.md"

block() {
  printf '%s\n' "$1" >&2
  exit 2   # PreCompact: exit 2 aborts the compaction
}

[[ -f "$MATH_FILE" ]] && \
  grep -q 'MATH-CRITICAL:BEGIN' "$MATH_FILE" || \
  block "Compaction aborted: docs/RENDER_ALGORITHMS.md is missing or lost its MATH-CRITICAL markers. The canonical coordinate transforms would be unrecoverable after compaction. Restore the file (git checkout docs/RENDER_ALGORITHMS.md) and retry."

BODY="$(awk '
  /MATH-CRITICAL:BEGIN/ { keep=1; next }
  /MATH-CRITICAL:END/   { keep=0; next }
  keep { print }
' "$MATH_FILE")"

[[ -n "${BODY// }" ]] || \
  block "Compaction aborted: the MATH-CRITICAL block in docs/RENDER_ALGORITHMS.md is empty."

mkdir -p "$(dirname "$SNAPSHOT")"
{
  echo "<!-- Auto-staged by PreCompact at $(date -u +%FT%TZ). Do not edit; source of truth is docs/RENDER_ALGORITHMS.md. -->"
  printf '%s\n' "$BODY"
} > "$SNAPSHOT"

exit 0
