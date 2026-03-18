#!/bin/bash
# Vercel Ignored Build Step: exit 0 = skip, exit 1 = build
# Only build when web-relevant files change. Skip desktop, docs, scripts, CI, etc.

# On main: skip if ONLY scripts/, docs/, .github/, or non-web files changed
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ] && [ -n "$VERCEL_GIT_PREVIOUS_SHA" ]; then
  git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA" 2>/dev/null && {
    WEB_CHANGES=$(git diff --name-only "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- \
      'src/' 'api/' 'server/' 'shared/' 'public/' 'blog-site/' 'pro-test/' 'proto/' \
      'package.json' 'package-lock.json' 'vite.config.ts' 'tsconfig.json' \
      'tsconfig.api.json' 'vercel.json' 'middleware.ts' | head -1)
    [ -z "$WEB_CHANGES" ] && echo "Skipping: no web-relevant changes on main" && exit 0
  }
  exit 1
fi

# Skip preview deploys that aren't tied to a pull request
[ -z "$VERCEL_GIT_PULL_REQUEST_ID" ] && exit 0

[ -z "$VERCEL_GIT_PREVIOUS_SHA" ] && exit 1
git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA" 2>/dev/null || exit 1

# Build if any of these web-relevant paths changed
git diff --name-only "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- \
  'src/' \
  'api/' \
  'server/' \
  'shared/' \
  'public/' \
  'blog-site/' \
  'pro-test/' \
  'proto/' \
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
