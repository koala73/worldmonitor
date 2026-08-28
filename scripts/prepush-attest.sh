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
#   bash scripts/prepush-attest.sh base-guard   <base-ref> [limit]  # "<base>\t<count>" on stdout
#   bash scripts/prepush-attest.sh gate-read    <cache-dir> <gate> <diff-resolved> -- <pathspec>...
#   bash scripts/prepush-attest.sh gate-write   <cache-dir> <gate> <diff-resolved> <attestable> -- <pathspec>...
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
  changed | changed-live | drift | dirty | cache-read | cache-write | base-guard | gate-read | gate-write) ;;
  *)
    echo "usage: $0 <changed|changed-live|drift|dirty|cache-read|cache-write|base-guard|gate-read|gate-write> [args]" >&2
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

  base-guard)
    # Branch-contamination ahead-count with a LAZY fetch (#6764). The hook
    # used to `git fetch` unconditionally before counting — 2s warm, 72s cold,
    # on every push — to protect a guard that almost never fires. Fetching can
    # only move origin/<base> FORWARD, so `rev-list --count origin/<base>..HEAD`
    # can only stay equal or SHRINK after a fetch. That premise is safe for the
    # protected main branch, but stacked bases and WM_BASE_REF may be
    # force-rewritten. Those mutable bases must be refreshed before accepting a
    # cached pass. Therefore:
    #
    #   cached count <= limit  ->  skip the network only for protected main;
    #                              fetch mutable bases and recount.
    #   cached count >  limit  ->  possibly a stale-ref false positive; fetch
    #                              to DISPROVE the violation, then recount.
    #   origin/<base> missing  ->  must fetch (first push of a stacked branch).
    #
    # Prints "<resolved-base>\t<count>". Exit 0 = within limit, 3 = violation
    # confirmed against a freshly fetched ref. A failed fetch (offline) is not
    # fatal: fall through to whatever is cached, as the hook always has.
    base="${2:-}"
    limit="${3:-20}"
    [ -n "$base" ] || usage_error "<base-ref> [limit]"

    fetch_base() {
      # Bounded and tag-free: an unbounded fetch inside a hook is how a push
      # hangs past its caller's budget.
      # Node 24 is a repository requirement and is available on every supported
      # developer machine. Keep the deadline in one portable implementation so
      # macOS hosts do not silently fall back to an unbounded fetch.
      if command -v node >/dev/null 2>&1; then
        WM_PREPUSH_FETCH_BASE="$1" node - <<'NODE'
const { spawnSync } = require('node:child_process');

const configured = Number(process.env.WM_PREPUSH_FETCH_TIMEOUT_MS);
const timeout = Number.isFinite(configured) && configured > 0 ? configured : 120_000;
const result = spawnSync(
  'git',
  ['fetch', '--no-tags', 'origin', process.env.WM_PREPUSH_FETCH_BASE, '--quiet'],
  { stdio: 'ignore', timeout, killSignal: 'SIGTERM' },
);
process.exit(result.error ? 1 : (result.status ?? 1));
NODE
      elif command -v timeout >/dev/null 2>&1; then
        timeout 120 git fetch --no-tags origin "$1" --quiet 2>/dev/null
      elif command -v gtimeout >/dev/null 2>&1; then
        gtimeout 120 git fetch --no-tags origin "$1" --quiet 2>/dev/null
      else
        # There is no safe way to invoke a fetch without a deadline. The
        # caller intentionally treats this as a failed corrective fetch and
        # evaluates whatever remote-tracking ref is already available.
        return 1
      fi
    }

    count_ahead() {
      git rev-list --count "origin/$1..HEAD" 2>/dev/null || echo 0
    }

    need_fetch=false
    count=0
    cache_safe=false
    had_cached_ref=false
    if [ "$base" = main ] && [ -z "${WM_BASE_REF:-}" ]; then
      cache_safe=true
    fi
    if ! git rev-parse --verify -q "origin/$base" >/dev/null; then
      need_fetch=true
    else
      had_cached_ref=true
      count=$(count_ahead "$base")
      # A non-main PR base or explicit WM_BASE_REF can be rebased or
      # force-pushed, so its cached relationship is not a sound pass even when
      # the cached count is within the limit. The default protected main branch
      # is the only relationship eligible for the lazy cached-pass shortcut.
      if [ "$cache_safe" != true ] || [ "$count" -gt "$limit" ]; then
        need_fetch=true
      fi
    fi

    if [ "$need_fetch" = true ]; then
      fetch_status=0
      fetch_base "$base" || fetch_status=$?
      # A mutable base with a cached ref cannot safely fall back to that stale
      # value after a failed refresh: the whole reason to fetch was to rule out
      # a force-rewrite. Preserve the historical fallback for an entirely
      # unresolvable base, where there is no cached relationship to trust.
      if [ "$cache_safe" != true ] && [ "$had_cached_ref" = true ] && [ "$fetch_status" -ne 0 ]; then
        echo "base-guard: could not refresh mutable 'origin/$base'" >&2
        exit 1
      fi
      if ! git rev-parse --verify -q "origin/$base" >/dev/null; then
        echo "base-guard: 'origin/$base' not resolvable, falling back to origin/main" >&2
        base="main"
        fetch_base "$base"
      fi
      count=$(count_ahead "$base")
    fi

    printf '%s\t%s\n' "$base" "$count"
    [ "$count" -le "$limit" ] || exit 3
    ;;

  gate-read | gate-write)
    # Per-gate green cache (#6765). The whole-tree cache above is all-or-
    # nothing: any byte anywhere invalidates every gate, so it never hits in
    # a merge/amend loop. These modes key ONE gate on the WORKTREE bytes of
    # ITS declared inputs — the bytes the gate actually executes — so a
    # docs-only amend re-pays the markdown lint and nothing else.
    #
    # Key = hash of (gate name + sorted input paths + each path's worktree
    # blob hash). Inputs are enumerated with `ls-files -z -co
    # --exclude-standard`: tracked AND untracked-unignored files both count
    # (a brand-new source file is an input change), gitignored build output
    # does not, and -z means a unicode/backslash/newline path can never be
    # C-quoted into a name that silently drops out of the key — the same
    # class of hole the `changed` modes close above.
    #
    # The refusal rules deliberately mirror cache-write below:
    #   * diff-resolved != true  -> no read, no write. The tree hash covers
    #     content-derived plan inputs but a blind RUN_ALL run must not trust
    #     or mint attestations (same reasoning as cache-read/cache-write).
    #   * attestable != true     -> no write. The key hashes worktree bytes,
    #     but the push ships HEAD; only when the two are byte-identical does
    #     "this gate passed on these bytes" also vouch for what is pushed.
    cache_dir="${2:-}"
    gate="${3:-}"
    diff_resolved="${4:-}"
    if [ "$mode" = gate-write ]; then
      attestable="${5:-}"
      shift 5
    else
      shift 4
    fi
    [ "${1:-}" = "--" ] && shift
    [ -n "$cache_dir" ] && [ -n "$gate" ] && [ -n "$diff_resolved" ] && [ "$#" -gt 0 ] ||
      usage_error "<cache-dir> <gate> <diff-resolved> [<attestable>] -- <pathspec>..."
    case "$gate" in
      *[!a-z0-9-]*)
        # The gate name becomes a file name inside cache_dir; anything
        # outside [a-z0-9-] could traverse or collide.
        echo "gate name must be [a-z0-9-]: $gate" >&2
        exit 2
        ;;
    esac

    gate_key() {
      # Streams through temp files: bash variables cannot hold NUL, and
      # every intermediate here is NUL-delimited by construction. Blob
      # hashing is bulk (`--stdin-paths`, one git exec for the whole set);
      # that interface is newline-delimited, so the rare legal path that
      # CONTAINS a newline is hashed individually via argv instead of being
      # mangled into two names that match nothing — the same class of hole
      # the -z reads above exist to close.
      local tmpdir status=0
      tmpdir="$(mktemp -d)" || return 1
      if ! git ls-files -z -co --exclude-standard -- "$@" > "$tmpdir/all" 2>/dev/null; then
        rm -rf "$tmpdir"; return 1
      fi
      : > "$tmpdir/paths"
      : > "$tmpdir/bulk_paths"
      local f
      while IFS= read -r -d '' f; do
        # ls-files -c also lists files deleted from the worktree; a missing
        # file simply drops out of the manifest, which changes the key.
        [ -f "$f" ] || continue
        printf '%s\0' "$f" >> "$tmpdir/paths"
        case "$f" in
          *$'\n'*) ;;
          *) printf '%s\n' "$f" >> "$tmpdir/bulk_paths" ;;
        esac
      done < "$tmpdir/all"
      if ! git hash-object --stdin-paths < "$tmpdir/bulk_paths" > "$tmpdir/bulk_hashes" 2>/dev/null; then
        rm -rf "$tmpdir"; return 1
      fi
      (
        exec 3< "$tmpdir/bulk_hashes"
        printf 'gate\0%s\0' "$gate"
        while IFS= read -r -d '' f; do
          printf '%s\0' "$f"
          case "$f" in
            *$'\n'*) git hash-object -- "$f" || exit 1 ;;
            *) IFS= read -r h <&3 || exit 1; printf '%s\n' "$h" ;;
          esac
        done < "$tmpdir/paths"
      ) > "$tmpdir/manifest" || status=1
      if [ "$status" -eq 0 ]; then
        git hash-object --stdin < "$tmpdir/manifest" || status=1
      fi
      rm -rf "$tmpdir"
      return "$status"
    }

    if [ "$diff_resolved" != true ]; then
      [ "$mode" = gate-write ] && echo "not caching $gate: the branch diff could not be resolved."
      exit 3
    fi

    key="$(gate_key "$@")" || exit 1
    [ -n "$key" ] || exit 1

    if [ "$mode" = gate-read ]; then
      [ -f "$cache_dir/$gate" ] || exit 3
      grep -qxF "$key" "$cache_dir/$gate" 2>/dev/null || exit 3
    else
      [ -n "$attestable" ] || usage_error "<cache-dir> <gate> <diff-resolved> <attestable> -- <pathspec>..."
      if [ "$attestable" != true ]; then
        echo "not caching $gate: the worktree is not byte-identical to HEAD."
        exit 3
      fi
      mkdir -p "$cache_dir" || exit 1
      printf '%s\n' "$key" > "$cache_dir/$gate" || exit 1
    fi
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
esac

exit 0
