#!/usr/bin/env bash
#
# Green-tree attestation primitives for .husky/pre-push (#5800).
#
# The hook's cache records `HEAD^{tree}` and, on a later push of that same tree,
# skips every tree-dependent gate. That makes each of these a "bad run that
# suppresses future runs" rather than "one bad run", so the decisions below are
# the sharp edge of the whole gate:
#
#   * WHICH paths changed         — read NUL-delimited, so `core.quotePath`
#                                   C-quoting (unicode, backslash, newline)
#                                   cannot rename a path into one that no
#                                   longer exists and gets silently skipped.
#   * WHICH of those exist in HEAD — asked of git (`--diff-filter=d`), never
#                                   inferred from `[ -f ]` against a worktree
#                                   that may have drifted from HEAD.
#   * WHETHER the run attests HEAD — the gates execute the WORKTREE; the cache
#                                   claims HEAD. Those are the same bytes only
#                                   when the tracked tree is clean.
#
# They live here, in modes a test can execute against real git fixtures
# (tests/prepush-attest.test.mjs), instead of inline in the hook where only a
# grep over its source text could guard them — and a source grep stays green
# when `true` is flipped to `false`.
#
# Usage:
#   bash scripts/prepush-attest.sh changed      <base-ref>   # NUL list
#   bash scripts/prepush-attest.sh changed-live <base-ref>   # NUL list, minus deletions
#   bash scripts/prepush-attest.sh drift        <base-ref>   # NUL list of offenders
#   bash scripts/prepush-attest.sh dirty                     # NUL list of offenders
#   bash scripts/prepush-attest.sh cache-read   <file> <tree> <diff-resolved>
#   bash scripts/prepush-attest.sh cache-write  <file> <tree> <diff-resolved> <attestable>
#   bash scripts/prepush-attest.sh gate-cache-read  <dir> <gate> <hash>
#   bash scripts/prepush-attest.sh gate-cache-write <dir> <gate> <hash> <attestable>
#
# Exit codes are three-valued on purpose. A gate that answers "no" and a gate
# that could not run must never collapse into the same status as "yes":
#
#   0  yes / clean / hit / written
#   3  no  / drift / dirty / miss / refused   (the list, or the reason, on stdout)
#   2  usage error
#   1  internal failure (git unavailable, unwritable cache, ...)

mode="${1:-}"
case "$mode" in
  changed | changed-live | drift | dirty | cache-read | cache-write \
          | gate-cache-read | gate-cache-write) ;;
  *)
    echo "usage: $0 <changed|changed-live|drift|dirty|cache-read|cache-write|gate-cache-read|gate-cache-write> [args]" >&2
    exit 2
    ;;
esac

usage_error() {
  echo "usage: $0 $mode $1" >&2
  exit 2
}

# require_base: the three-dot diff the hook scopes with needs both a resolvable
# base ref AND a merge base with HEAD. Checking up front means a later `git
# diff` failure cannot half-emit a path list that reads as a complete one.
require_base() {
  git rev-parse --verify -q "${1}^{commit}" >/dev/null 2>&1 || exit 3
  git merge-base "$1" HEAD >/dev/null 2>&1 || exit 3
}

# read_nul <array-name-less loop>: appends NUL-delimited stdin into `collected`.
# `read -d ''` rather than a line read — a path may legally contain a newline,
# and the whole point of this file is that no legal path goes missing.
collected=()
read_nul() {
  local path
  collected=()
  while IFS= read -r -d '' path; do
    [ -n "$path" ] || continue
    collected+=("$path")
  done
}

case "$mode" in
  changed | changed-live)
    base="${2:-}"
    [ -n "$base" ] || usage_error "<base-ref>"
    require_base "$base"
    # `--diff-filter=d` excludes deletions (lowercase = exclude), i.e. "the
    # paths that exist in the pushed commit". Spelled as an exclusion rather
    # than an ACMR allow-list so a status letter git adds later still lands on
    # the "exists" side instead of vanishing from the run.
    #
    # `--no-renames` because rename detection reports ONLY the destination:
    # `scripts/seed-x.mjs` -> `tests/x.test.mjs` would leave nothing under
    # scripts/ in the list, so the seed category never fires for a push that
    # unmistakably touched it. Every gate here scopes by path prefix, and a
    # path that stopped existing is exactly as interesting as one that started.
    if [ "$mode" = changed-live ]; then
      git diff --name-only -z --no-renames --diff-filter=d "$base...HEAD" || exit 1
    else
      git diff --name-only -z --no-renames "$base...HEAD" || exit 1
    fi
    ;;

  drift)
    # Paths this push CHANGES whose worktree bytes differ from HEAD. The gates
    # would test the worktree copy while git pushes the HEAD copy: an unstaged
    # fix reads as a passing suite over broken committed bytes, an unstaged
    # delete drops the file from the run entirely. Both then cache HEAD green.
    base="${2:-}"
    [ -n "$base" ] || usage_error "<base-ref>"
    require_base "$base"

    read_nul < <(git diff --name-only -z --no-renames "$base...HEAD")
    # No paths in the branch diff means nothing this push changes can have
    # drifted. Guarding is not just an optimisation: `diff -- ` with an empty
    # pathspec list means ALL paths, which would report every unrelated
    # worktree edit as drift and block the push.
    [ "${#collected[@]}" -gt 0 ] || exit 0

    # Intersect via git rather than a nested bash loop: `git diff HEAD` limited
    # to the branch paths IS the intersection, matched in C. `--literal-pathspecs`
    # because a path containing `*`, `?` or `[` is a legal filename but glob
    # magic to a pathspec. (`--pathspec-from-file` is not supported by
    # `git diff`, so the list goes through argv; on overflow git fails loudly,
    # which the caller reports as "could not compare" rather than "clean".)
    #
    # `git diff HEAD` covers staged and unstaged alike — the index is not what
    # gets pushed either.
    found=0
    while IFS= read -r -d '' drifted; do
      [ -n "$drifted" ] || continue
      printf '%s\0' "$drifted"
      found=1
    done < <(git --literal-pathspecs diff --name-only -z HEAD -- "${collected[@]}")
    [ "$found" -eq 0 ] || exit 3
    ;;

  dirty)
    # Anything that makes the worktree differ from HEAD, in scope or not. This
    # governs only whether the run may be CACHED as an attestation of
    # `HEAD^{tree}` — an unrelated edit still means the gates ran against bytes
    # that are not the ones being stamped green. Untracked-but-not-ignored
    # counts: a forgotten `git add` is a file the gates can import and the push
    # cannot deliver.
    found=0
    read_nul < <(git diff --name-only -z HEAD --)
    for path in "${collected[@]}"; do
      printf '%s\0' "$path"
      found=1
    done
    read_nul < <(git ls-files -z --others --exclude-standard)
    for path in "${collected[@]}"; do
      printf '%s\0' "$path"
      found=1
    done
    [ "$found" -eq 0 ] || exit 3
    ;;

  cache-read)
    cache_file="${2:-}"
    tree="${3:-}"
    diff_resolved="${4:-}"
    [ -n "$cache_file" ] && [ -n "$diff_resolved" ] || usage_error "<file> <tree> <diff-resolved>"
    # Reads stay disabled when the branch diff could not be resolved: the tree
    # hash captures content-derived plan inputs (a package.json change is in
    # the tree) but NOT state-derived ones, so a blind run must not trust an
    # attestation minted under a scoped plan it can no longer verify.
    [ "$diff_resolved" = true ] || exit 3
    [ -n "$tree" ] || exit 3
    [ -f "$cache_file" ] || exit 3
    grep -qxF "$tree" "$cache_file" 2>/dev/null || exit 3
    ;;

  cache-write)
    cache_file="${2:-}"
    tree="${3:-}"
    diff_resolved="${4:-}"
    attestable="${5:-}"
    [ -n "$cache_file" ] && [ -n "$diff_resolved" ] && [ -n "$attestable" ] ||
      usage_error "<file> <tree> <diff-resolved> <attestable>"

    if [ -z "$tree" ]; then
      echo "not caching: HEAD has no resolvable tree hash."
      exit 3
    fi
    if [ "$diff_resolved" != true ]; then
      # The fallback run is NOT "everything ran, the strongest attestation" —
      # it sets RUN_ALL, and RUN_ALL explicitly skips the local unit suite. On
      # a multi-commit branch the HEAD~1 fallback never even looked at the
      # earlier commits. Stamping HEAD green here lets a later run, once
      # origin/main resolves again, cache-hit straight past all of it.
      echo "not caching: the branch diff could not be resolved, so this run skipped the unit suite."
      exit 3
    fi
    if [ "$attestable" != true ]; then
      # The gates ran against a worktree that is not HEAD. Whatever they
      # proved, they did not prove it about the tree being stamped.
      echo "not caching: the worktree is not byte-identical to HEAD."
      exit 3
    fi
    printf '%s\n' "$tree" > "$cache_file" || exit 1
    ;;

  # Per-gate cache (#6765). The whole-tree cache keys every gate on one hash,
  # so a merge, conflict re-resolve, amend, or regenerated-artifact commit —
  # each a new HEAD^{tree} — invalidates gates whose inputs did not change.
  # A gate entry instead names ONE hash of exactly that gate's inputs AND
  # verified outputs, so an unrelated amend leaves it valid. Layout is one
  # file per gate under <dir>, holding a single hash line an operator can
  # inspect and clear.
  gate-cache-read)
    cache_dir="${2:-}"
    gate="${3:-}"
    hash="${4:-}"
    [ -n "$cache_dir" ] && [ -n "$gate" ] && [ -n "$hash" ] ||
      usage_error "<dir> <gate> <hash>"
    # No diff-resolved or attestable term here by design: callers only reach
    # for a per-gate read when they already hold ATTESTABLE=true — the hash
    # names HEAD-tree bytes, and a drifted worktree would make the key a lie
    # about what actually ran. Keeping that decision at the call site keeps
    # this primitive honest with a single rule to test.
    [ -f "$cache_dir/$gate" ] || exit 3
    grep -qxF "$hash" "$cache_dir/$gate" 2>/dev/null || exit 3
    ;;

  gate-cache-write)
    cache_dir="${2:-}"
    gate="${3:-}"
    hash="${4:-}"
    attestable="${5:-}"
    [ -n "$cache_dir" ] && [ -n "$gate" ] && [ -n "$hash" ] && [ -n "$attestable" ] ||
      usage_error "<dir> <gate> <hash> <attestable>"
    if [ "$attestable" != true ]; then
      # The gate ran against a worktree that is not HEAD. Whatever it proved,
      # it did not prove it about the bytes the hash names — same refusal the
      # whole-tree cache-write makes, for the same reason.
      echo "not gate-caching: the worktree is not byte-identical to HEAD."
      exit 3
    fi
    mkdir -p "$cache_dir" || exit 1
    printf '%s\n' "$hash" > "$cache_dir/$gate" || exit 1
    ;;
esac

exit 0
