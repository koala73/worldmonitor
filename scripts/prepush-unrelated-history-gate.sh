#!/usr/bin/env bash
# Pre-push gate: refuse to publish a branch that shares no history with
# origin/main.
#
# Why this exists: agents kept pushing PR screenshots to orphan, image-only
# branches (`pr-assets`, `assets/*`, `dogfood/<issue>-screenshots`) and linking
# them from PR bodies via raw.githubusercontent.com. Such a tree has no
# vercel.json, so Vercel never runs scripts/vercel-ignore.sh and instead runs
# the project build command on an empty checkout: every push lands a failed
# "Vercel" status (`npm error enoent Could not read package.json`). PR
# screenshots belong in the PR description via `gh pr edit --attach` (see
# AGENTS.md "Include UI evidence in pull requests").
#
# Input: the pre-push stdin, one line per ref:
#   <local ref> <local sha> <remote ref> <remote sha>
# Deletions and tags are skipped. When origin/main is not known locally, or a
# shallow clone hides the shared ancestor, the gate cannot judge, so it passes. Escape hatch: WM_ALLOW_UNRELATED_PUSH=1.
set -uo pipefail

[ -n "${WM_ALLOW_UNRELATED_PUSH:-}" ] && exit 0

BASE=$(git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}') || exit 0

ZERO_RE='^0+$'
fail=0
while read -r local_ref local_sha remote_ref _remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  printf '%s' "$local_sha" | grep -qE "$ZERO_RE" && continue
  case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac
  git cat-file -e "${local_sha}^{commit}" 2>/dev/null || continue
  if ! git merge-base "$local_sha" "$BASE" >/dev/null 2>&1; then
    # A shallow boundary acts as a root, so a related branch can look
    # unrelated. Incomplete history cannot prove anything: warn and pass.
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      echo "UNRELATED-HISTORY GATE: shallow clone, cannot check $remote_ref against origin/main (run: git fetch --unshallow origin)."
      continue
    fi
    echo "UNRELATED-HISTORY GATE: refusing to push $local_ref -> $remote_ref"
    echo "  $local_sha shares no history with origin/main."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "An orphan branch has no vercel.json, so Vercel builds it and fails."
  echo "For PR screenshots, upload them into the PR description instead:"
  echo "  gh pr edit <number> --attach '/absolute/path/shot.png#What it shows'"
  echo "Intentional unrelated history? Re-run with WM_ALLOW_UNRELATED_PUSH=1."
  exit 1
fi
exit 0
