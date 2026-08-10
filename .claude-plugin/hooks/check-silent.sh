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
      # ESLint 9 dropped the `unix`/`compact` formatters from core. Use the built-in
      # json formatter and render one terse line per problem — cheapest stable form.
      if ! RAW="$(node_modules/.bin/eslint --format json "$FILE" 2>/dev/null)"; then
        LINT="$(printf '%s' "$RAW" | python3 -c '
import json, sys
try:
    files = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for f in files:
    for m in f.get("messages", []):
        sev = "error" if m.get("severity") == 2 else "warn"
        rule = m.get("ruleId") or "parse"
        print(f'"'"'{f["filePath"]}:{m.get("line",0)}:{m.get("column",0)} {sev} {m.get("message","")} [{rule}]'"'"')
')"
        [[ -n "${LINT// }" ]] && OUT+="ESLint:"$'\n'"$LINT"$'\n'
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
