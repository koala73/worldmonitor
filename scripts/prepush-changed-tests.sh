#!/usr/bin/env bash
#
# Decide which runner owns each changed test file in a push, and run them (#5795).
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
# The `run-*` modes exist for the same reason: while the hook held the
# "is this list non-empty, and which runner do I invoke" decision inline, that
# decision could only be guarded by grepping the hook's source text — and a
# source grep stays green when `-n` is flipped to `-z` or `|| exit 1` is
# dropped. Here it is a behavior a test can execute against stubbed runners.
#
# Usage:
#   printf '%s\n' "$CHANGED_FILES"     | bash scripts/prepush-changed-tests.sh node
#   printf '%s\n' "$CHANGED_FILES"     | bash scripts/prepush-changed-tests.sh dom
#   printf '%s\n' "$TESTS_CHANGED"     | bash scripts/prepush-changed-tests.sh run-node
#   printf '%s\n' "$DOM_TESTS_CHANGED" | bash scripts/prepush-changed-tests.sh run-dom
#
# The two partition modes read a newline-separated list of repo-relative
# changed paths on stdin and write the subset owned by that runner to stdout,
# skipping paths the push deleted (a runner invoked with a removed file fails
# on the missing file, not on the code).
#
# The two run modes read that runner's final file list and exit non-zero when
# the runner fails. An empty list is a no-op, not a failure.

TEST_TIMEOUT="${WM_PREPUSH_TEST_TIMEOUT:-120}"

mode="${1:-}"
case "$mode" in
  node | dom | run-node | run-dom) ;;
  *)
    echo "usage: $0 <node|dom|run-node|run-dom>" >&2
    exit 2
    ;;
esac

# read_list: stdin -> the `selected` array, dropping blank lines.
selected=()
read_list() {
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    selected+=("$line")
  done
}

# partition: stdin -> the `selected` array, filtered to files this runner owns.
partition() {
  local want="$1" file owner
  while IFS= read -r file; do
    [ -n "$file" ] || continue

    # Ownership first, extension second. Both extensions live under tests/dom/ —
    # vitest.dom.config.mts includes `tests/dom/**/*.test.{mts,mjs}`, so an
    # .mts-only carve-out would strand a `.mjs` DOM test in neither runner.
    case "$file" in
      tests/dom/*) owner=dom ;;
      *) owner=node ;;
    esac
    [ "$owner" = "$want" ] || continue

    printf '%s\n' "$file" | grep -qE '^tests/.*\.test\.(mjs|mts)$' || continue
    [ -f "$file" ] || continue

    selected+=("$file")
  done
}

case "$mode" in
  node | dom)
    partition "$mode"
    [ "${#selected[@]}" -eq 0 ] || printf '%s\n' "${selected[@]}"
    ;;

  run-node)
    read_list
    if [ "${#selected[@]}" -eq 0 ]; then
      exit 0
    fi
    echo "Running changed test files only..."
    # Quoted expansion, not word-splitting: a test path containing a space is
    # one argument, not two nonexistent ones.
    timeout "$TEST_TIMEOUT" npx tsx --test "${selected[@]}" || exit 1
    ;;

  run-dom)
    read_list
    if [ "${#selected[@]}" -eq 0 ]; then
      exit 0
    fi
    echo "Running DOM tests (tests/dom/ changed)..."
    # The whole project rather than the changed files: vitest treats positional
    # args as regex filters over paths, so a literal filename carrying a regex
    # metacharacter can match nothing and fail the push as "No test files
    # found". The suite is a handful of files and happy-dom boots per file in
    # milliseconds (see vitest.dom.config.mts), so scoping buys nothing here.
    timeout "$TEST_TIMEOUT" npm run test:dom || exit 1
    ;;
esac

exit 0
