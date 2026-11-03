---
title: "A raw test run reads a stale docs date manifest that npm run test:data would have regenerated"
date: 2026-10-06
category: test-failures
module: tests/docs-locale-seo
problem_type: test_failure
component: testing_framework
severity: low
symptoms:
  - "docs-locale-seo fails with 'date manifest must carry datePublished for docs/<page>.mdx, run npm run docs:dates'"
  - "The failure appears on a clean origin/main checkout with no local edits"
  - "The same file passes under npm run test:data and in CI"
root_cause: incomplete_setup
resolution_type: workflow_improvement
related_components: [documentation, development_workflow]
tags: [docs-page-dates, pretest-hook, false-red, generated-file, node-test, test-data]
---

# A raw test run reads a stale docs date manifest that npm run test:data would have regenerated

## Problem

`tests/docs-locale-seo.test.mts` imports `src/config/docs-page-dates.generated.ts` and asserts that every committed docs slug has a date. That manifest is tracked in git, but the committed copy is not kept current. `package.json` regenerates it before every data run through `"pretest:data": "npm run docs:dates"`, and the CI `docs-stats` job regenerates it per revision. A test run that bypasses the npm script reads the stale committed copy and fails.

## Symptoms

On a fresh worktree of `origin/main` at 2026-10-06, a direct run failed:

```text
npx tsx --test tests/docs-locale-seo.test.mts
✖ covers every committed docs slug in the date manifest
  AssertionError: date manifest must carry datePublished for docs/panels/news-market-correlation.mdx (message truncated)
```

The committed manifest was last changed on 2026-09-23 (#8547). The page was added on 2026-10-06 (#8887). `node scripts/run-data-tests.mjs tests/docs-locale-seo.test.mts` fails the same way, because the runner script does not run the npm `pretest:data` hook.

## What Didn't Work

Treating the red as a regression from the branch under test. The failure reproduces on pristine `origin/main` and names a page the branch never touched.

## Solution

Prefer `npm run test:data`, which runs the `docs:dates` pre-step itself. For a direct run, first check that the manifest has no local edits, then regenerate it, run the test, and restore only the regenerated copy so it does not ride along in an unrelated commit:

```bash
git diff --quiet -- src/config/docs-page-dates.generated.ts || echo "manifest has local edits: commit or stash them first"
npm run --silent docs:dates
npx tsx --test tests/docs-locale-seo.test.mts   # 37 pass, 0 fail
git restore -- src/config/docs-page-dates.generated.ts   # only if the first command printed nothing
```

Or run through the npm script, which triggers the hook: `npm run test:data`.

## Why This Works

The generator derives dates from git history at the current revision. The `pretest:data` hook and the CI job both run it first, so they always test a manifest that matches the tree. A raw `node --test`, `tsx --test`, or `scripts/run-data-tests.mjs` call skips npm lifecycle hooks and tests whatever copy is on disk.

## Prevention

- When a docs test names a missing date or slug, run `npm run docs:dates` and rerun before investigating.
- After `npm run test:data`, check `git status` for a modified `src/config/docs-page-dates.generated.ts` and leave it out of commits unless the change is intended.
- Any test that reads a file a `pre*` npm hook generates has this shape. Read the matching `pre` script in `package.json` before running such a test directly.
