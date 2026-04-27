#!/bin/bash
# Vercel Ignored Build Step: exit 0 = skip, exit 1 = build
# Only build when web-relevant files change. Skip desktop, docs, scripts, CI, etc.

# On main: skip if ONLY scripts/, docs/, .github/, or non-web files changed
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ] && [ -n "$VERCEL_GIT_PREVIOUS_SHA" ]; then
  git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA" 2>/dev/null && {
    WEB_CHANGES=$(git diff --name-only "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- \
      'src/' 'api/' 'server/' 'shared/' 'public/' 'blog-site/' 'pro-test/' 'proto/' 'convex/' \
      'package.json' 'package-lock.json' 'vite.config.ts' 'tsconfig.json' \
      'tsconfig.api.json' 'vercel.json' 'middleware.ts' | head -1)
    [ -z "$WEB_CHANGES" ] && echo "Skipping: no web-relevant changes on main" && exit 0
  }
  exit 1
fi

# Resolve comparison base: prefer `merge-base HEAD origin/main` (the SHA
# where this branch left main), fall back to VERCEL_GIT_PREVIOUS_SHA.
#
# We deliberately do NOT gate on VERCEL_GIT_PULL_REQUEST_ID. Vercel only
# populates that var when the deploy is triggered by a fresh PR-aware
# webhook event; manual "Redeploy" / "Redeploy without cache" actions
# from the dashboard, and some integration edge cases, leave it empty
# even on commits that are clearly attached to an open PR. Gating on it
# silently cancels legitimate previews (PR #3403 incident: 24d511e on
# feat/usage-telemetry, all 5 api/ + server/ files skipped).
#
# The merge-base diff below is the authoritative "did this branch touch
# anything web-relevant" check, and it's strictly stronger than the
# PR-ID guard: branches with no web changes still skip via that diff,
# branches with web changes build whether or not Vercel happens to know
# about a PR association at deploy time.
#
# Why merge-base is preferred over PREVIOUS_SHA: on a branch's FIRST
# push, Vercel has historically set VERCEL_GIT_PREVIOUS_SHA to values
# that make the path-diff come back empty (the same SHA as HEAD, or a
# parent that sees no net change), causing "Canceled by Ignored Build
# Step" on commits that genuinely touch web paths (PR #3346 incident).
# merge-base is the stable truth: "everything on this branch since it
# left main", which is always a superset of any single push.
#
# PREVIOUS_SHA stays as the fallback for the rare shallow-clone edge
# case where `origin/main` isn't in Vercel's clone and merge-base
# returns empty. This is the opposite priority from the main-branch
# block above (line 6), which correctly wants PREVIOUS_SHA = the last
# deployed commit.
COMPARE_SHA=$(git merge-base HEAD origin/main 2>/dev/null)
if [ -z "$COMPARE_SHA" ] && [ -n "$VERCEL_GIT_PREVIOUS_SHA" ]; then
  git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA" 2>/dev/null && COMPARE_SHA="$VERCEL_GIT_PREVIOUS_SHA"
fi
[ -z "$COMPARE_SHA" ] && exit 1

# Build if any of these web-relevant paths changed
git diff --name-only "$COMPARE_SHA" HEAD -- \
  'src/' \
  'api/' \
  'server/' \
  'shared/' \
  'public/' \
  'blog-site/' \
  'pro-test/' \
  'proto/' \
  'convex/' \
  'package.json' \
  'package-lock.json' \
  'vite.config.ts' \
  'tsconfig.json' \
  'tsconfig.api.json' \
  'vercel.json' \
  'middleware.ts' \
  | grep -q . && exit 1

# Nothing web-relevant changed, skip the build
exit 0
