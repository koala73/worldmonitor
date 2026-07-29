#!/usr/bin/env bash
#
# Decide which runner owns each changed test file in a push (#5795).
#
# The repo has two test runners and they are not interchangeable:
#
#   tests/dom/**   vitest + happy-dom (vitest.dom.config.mts, `npm run test:dom`).
#                  These files import `vitest` and reach components that use
#                  `import.meta.glob`, neither of which tsx/node:test can
#                  resolve — feeding one to `tsx --test` fails inside the
#                  runner and reads as "your DOM test is broken".
#   tests/*        node:test via `tsx --test` (`npm run test:data`).
#
# .husky/pre-push used to sweep both into `tsx --test`, making the gate
# unpassable for every DOM-test change. Keeping the split here — one place,
# executed by tests/prepush-changed-tests.test.mjs — means the hook can't drift
# back into a single glob, and neither can a file end up in NO runner (a silent
# coverage gap is the failure mode that replaces the loud one).
#
# Usage:
#   printf '%s\n' "$CHANGED_FILES" | bash scripts/prepush-changed-tests.sh node
#   printf '%s\n' "$CHANGED_FILES" | bash scripts/prepush-changed-tests.sh dom
#
# Reads a newline-separated list of repo-relative changed paths on stdin and
# writes the subset owned by <mode> to stdout, skipping paths the push deleted
# (a runner invoked with a removed file fails on the missing file, not the code).

mode="${1:-}"
case "$mode" in
  node | dom) ;;
  *)
    echo "usage: $0 <node|dom>" >&2
    exit 2
    ;;
esac

while IFS= read -r file; do
  [ -n "$file" ] || continue

  # Ownership first, extension second. Both extensions live under tests/dom/ —
  # vitest.dom.config.mts includes `tests/dom/**/*.test.{mts,mjs}`, so an
  # .mts-only carve-out would strand a `.mjs` DOM test in neither runner.
  case "$file" in
    tests/dom/*) owner=dom ;;
    *) owner=node ;;
  esac
  [ "$owner" = "$mode" ] || continue

  printf '%s\n' "$file" | grep -qE '^tests/.*\.test\.(mjs|mts)$' || continue
  [ -f "$file" ] || continue

  printf '%s\n' "$file"
done

exit 0
