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

# Skip preview deploys that aren't tied to a pull request
[ -z "$VERCEL_GIT_PULL_REQUEST_ID" ] && exit 0

# Resolve comparison base: prefer `merge-base HEAD origin/main` (the SHA
# where this PR branched off main), fall back to VERCEL_GIT_PREVIOUS_SHA.
#
# Why this ordering: on a PR branch's FIRST push, Vercel has historically
# set VERCEL_GIT_PREVIOUS_SHA to values that make the path-diff come back
# empty (the same SHA as HEAD, or a parent that sees no net change),
# causing "Canceled by Ignored Build Step" on PRs that genuinely touch
# web paths (PR #3346 incident: four web-relevant files changed, skipped
# anyway). merge-base is the stable truth: "everything on this PR since
# it left main", which is always a superset of any single push and is
# what the reviewer actually needs a preview for.
#
# PREVIOUS_SHA stays as the fallback for the rare shallow-clone edge case
# where `origin/main` isn't in Vercel's clone and merge-base returns
# empty. This is the opposite priority from the main-branch branch above
# (line 6), which correctly wants PREVIOUS_SHA = the last deployed commit.
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
