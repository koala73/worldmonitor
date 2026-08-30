#!/usr/bin/env bash
# Pre-push identity gate: refuse to publish commits carrying a leaked
# test-fixture identity, and fail fast when the SHARED repo config currently
# holds one (the next commit would be poisoned).
#
# Why this exists: test fixtures shell out to `git config user.name/email`.
# When such a test runs UNDER A GIT HOOK, git exports GIT_DIR/GIT_WORK_TREE/
# GIT_INDEX_FILE to the hook's children, and those OVERRIDE the fixture's cwd —
# the identity write lands in the SHARED .git/config, and every later commit
# from ANY worktree silently carries the fake author. Observed incidents:
# "Fixture <fixture@example.invalid>" (2026-08-30), "test <test@example.com>"
# (2026-08-29/30), "WorldMonitor Test <test@worldmonitor.app>", "e <e@e.co>".
# The hook-side env strip prevents the write at current SHAs; THIS gate is the
# boundary that keeps any residual leak (e.g. a stale worktree's old tests)
# from ever reaching GitHub.
#
# Input: the pre-push stdin, one line per ref:
#   <local ref> <local sha> <remote ref> <remote sha>
# New branches (all-zero remote sha) are checked as "commits not on any
# origin ref"; deletions (all-zero local sha) are skipped.
set -euo pipefail

# Fixture-pattern emails only — names are too ambiguous to block on.
# example.com/.invalid/.test are RFC-reserved and never a real contributor.
BAD_EMAIL_RE='@example\.(invalid|test|com)$|^e@e\.co$|^fixture@|^test@worldmonitor\.app$'

ZERO_RE='^0+$'
fail=0

report_commit() {
  echo "IDENTITY GATE: refusing to push commit $1"
  echo "  author:    $2"
  echo "  committer: $3"
}

check_range() {
  # $@ = git rev-list selector for the new commits of one pushed ref
  while IFS=$'\t' read -r sha author committer; do
    [ -z "${sha:-}" ] && continue
    local blocked=0
    for who in "$author" "$committer"; do
      email=${who##*<}
      email=${email%>}
      if printf '%s' "$email" | grep -qiE "$BAD_EMAIL_RE"; then blocked=1; fi
    done
    if [ "$blocked" -eq 1 ]; then
      report_commit "$sha" "$author" "$committer"
      fail=1
    fi
  done < <(git log --format='%H%x09%an <%ae>%x09%cn <%ce>' "$@" 2>/dev/null || true)
}

while read -r _local_ref local_sha _remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  if printf '%s' "$local_sha" | grep -qE "$ZERO_RE"; then continue; fi # deletion
  if [ -n "${remote_sha:-}" ] && ! printf '%s' "$remote_sha" | grep -qE "$ZERO_RE"; then
    check_range "$remote_sha..$local_sha"
  else
    check_range "$local_sha" --not --remotes=origin
  fi
done

# Shared-config check: a poisoned identity in the COMMON config poisons the
# next commit from every worktree even when the outgoing commits are clean.
common_config="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/config"
if [ -f "$common_config" ]; then
  current_email=$(git config --file "$common_config" --get user.email 2>/dev/null || true)
  if [ -n "$current_email" ] && printf '%s' "$current_email" | grep -qiE "$BAD_EMAIL_RE"; then
    echo "IDENTITY GATE: the SHARED repo config carries a test-fixture identity:"
    echo "  user.email = $current_email (in $common_config)"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "A test fixture leaked its git identity into the shared repo config"
  echo "(GIT_DIR from a git hook overrides a fixture's cwd). Repair:"
  echo "  1. Inspect:  git config --show-origin user.name user.email"
  echo "  2. Clean up: git config --file \"$common_config\" --unset user.name"
  echo "               git config --file \"$common_config\" --unset user.email"
  echo "  3. Rewrite the branch authors:"
  echo "     git rebase origin/main --exec 'git commit --amend --reset-author --no-edit'"
  echo "  4. Push again."
  exit 1
fi
exit 0
