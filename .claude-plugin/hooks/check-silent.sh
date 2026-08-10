#!/usr/bin/env bash
# PostToolUse hook: run ESLint + tsc after each edit.
# Token economics: on success, emit NOTHING. Only failures reach the context window,
# and only the first 40 lines of them.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

FILE="$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write((d.get("tool_input") or {}).get("file_path") or "")
')"

cd "$ROOT" || exit 0

# No toolchain yet (Phase 1 scaffold) -> stay silent.
[[ -f package.json && -d node_modules ]] || exit 0
[[ -n "$FILE" ]] || exit 0

OUT=""

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx)
    if [[ -x node_modules/.bin/eslint ]]; then
      if ! LINT="$(node_modules/.bin/eslint --format unix "$FILE" 2>&1)"; then
        OUT+="ESLint:"$'\n'"$LINT"$'\n'
      fi
    fi
    ;;
esac

case "$FILE" in
  *.ts|*.tsx)
    if [[ -x node_modules/.bin/tsc && -f tsconfig.json ]]; then
      # Project-wide check: type errors are non-local by nature.
      if ! TSC="$(node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1)"; then
        OUT+="tsc:"$'\n'"$TSC"$'\n'
      fi
    fi
    ;;
esac

# Clean run: emit nothing at all.
[[ -z "${OUT// }" ]] && exit 0

printf '%s\n' "$OUT" | head -n 40 >&2
exit 2
