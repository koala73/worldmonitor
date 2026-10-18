---
title: "Scope browser and codegen checks, and balance the full data suite"
date: 2026-09-05
category: performance-issues
module: CI tests
problem_type: performance_issue
component: testing_framework
root_cause: config_error
resolution_type: workflow_improvement
severity: medium
tags: [ci-performance, test-selection, sharding, railway, codegen]
---

# CI test selection and shards

A Railway registry CLI repair ran unrelated browser and code-generation jobs.
In [PR 7731's Test run](https://github.com/koala73/worldmonitor/actions/runs/33974053555),
the browser job took 484 seconds, the unit job 379 seconds, and its data tests
252 seconds. The separate proto pipeline took about 312 seconds. These jobs
overlapped; their durations are not additive savings.

## Selection and coverage

The browser job has its own selector. Known Railway registry inputs, documentation
and unit-test files can skip it. Runtime code, public assets, browser harnesses,
build tooling, package changes and unknown paths run it. The diff reader includes
old and new rename paths and retains deletions. Missing, moved, truncated or
unusable Test diff metadata runs every job.

Code generation uses explicit input and output paths. The existing dependency
guard walks the Makefile's generation scripts and their reads/imports, and verifies
that local pre-push pathspecs and the CI registry cover them. Changes to a generator,
its consumed contracts, generated output, packages or the proto workflow still run
freshness checks. Fork trust checks are unchanged; incomplete proto metadata still
blocks classification.

The complete data-test inventory is discovered on each invocation. The shards, with four test processes each,
balance estimated file durations; unmeasured files receive a default cost and
still run. The Node test API receives literal files, so a second glob expansion
cannot omit a filename with brackets. Long files start first. The required `unit`
aggregate rejects failed, cancelled or unexpectedly skipped shards.

## Build once, not per shard

Until 2026-09-30 every shard ran the `/pro` and dashboard builds (58-69 s) for the
44 suites that read them, three times over. Now `unit-built-output` builds once,
runs the bundle budgets, the tree-wide checks (zh-TW catalogues, health-probe
cutovers, OpenAPI capacity, edge and sidecar bundles, desktop env parity) and
`test:data --built-output=only`. The shards run `--built-output=exclude` with no
build. `unit` requires both jobs.

A suite belongs to the build job when its source names `dist/`, `public/pro/`,
`WM_EXPECT_BUILT_OUTPUT` or a built-output guard (`readsBuiltOutput` in
`scripts/run-data-tests.mjs`). Over-matching is harmless. The shards keep
`WM_EXPECT_BUILT_OUTPUT=1`, so a guarded suite that lands in a shard fails on the
missing tree instead of skipping. `tests/data-test-shards.test.mjs` proves the
shards and the build job together run the inventory exactly once.

`build:pro` also installs `pro-test/node_modules`, so a suite that loads
`pro-test/vite.config.ts` needs the build job too even though it reads no built
file. A local proof run missed this because the worktree already had that tree;
CI failed `sentry-release-build` with `ERR_MODULE_NOT_FOUND`. The classifier now
matches `pro-test/node_modules` and `pro-test/vite.config`. When checking a
split like this, compare each file's test and skip counts between CI runs from
before and after it (download the `data-test-timings-*` artifacts), not against a
local checkout that carries side effects from earlier installs.

Measured on the PR's first green run: `unit` finished at 277 s against a
25-PR median of about 355 s, with shards at 209-253 s and the build job at
146 s. The browser smoke leg (about 290 s) is now the slowest check.

Shards check out full history blobless (`filter: blob:none`): about 30 suites
read commit history, not old file contents. Running those 34 files in a
blobless clone gave the same results as a full clone and lazily fetched one
blob, from a clone a third of the size.

`scripts/shared/data-test-durations.json` must stay current or placement drifts:
`natural-events-transport` (111 s in CI) had no entry and was costed at 1 s,
which left one shard 45 s behind the others.

## Local commands

Use the focused edit loop:

```sh
npm run test:railway-registry
```

It retains missing-key, idempotence, unsafe configuration, failed read/write and
non-convergence cases through the real CLI with a local fake Railway executable.
When source-health behavior changes, add the expanded proof once before delivery:

```sh
node --import tsx --test --test-concurrency=2 tests/seed-freshness-monitor.test.mjs tests/seed-health-status-publisher.test.mjs
```

Keep `npm run test:data` as the complete-suite command. Reproduce one CI shard with:

```sh
WM_EXPECT_BUILT_OUTPUT=1 npm run test:data -- --built-output=exclude --shard=1/3 --concurrency=4 --timings=/tmp/data-test-timings.jsonl
```

and the build job's suites with:

```sh
npm run build:pro
VITE_VARIANT=full ./node_modules/.bin/vite build
WM_EXPECT_BUILT_OUTPUT=1 npm run test:data -- --built-output=only --concurrency=4
```

Use `--list` to inspect selected files without running them. Run heavy local checks sequentially. CI uploads each shard's timing
JSONL separately. `scripts/shared/data-test-durations.json` contains estimates for
every measured file; it controls placement only. Refresh estimates from the
`data-test-timings-*` artifacts of a successful CI run, not a local machine. Do not use reporter row counts as
the test inventory: some existing suites change `NODE_TEST_CONTEXT` and suppress
their per-file summary. The glob inventory and partition contract remain the proof.

## Browser failure evidence

The saved failed-attempt trace in the same baseline run records
`Object with guid response@... was not bound in the connection` during
`waitForStartup()` navigation, before readiness and request-budget assertions.
Only the test trace and source attachments survived. It cannot establish whether
the cause was renderer loss, browser exit or protocol ordering.

[PR 7718](https://github.com/koala73/worldmonitor/pull/7718) owns browser-loss
diagnostics. This change retains retry reporting, failed-attempt artifacts and
the negative request-budget observation windows. It does not claim a flake fix.

## Measurements

The initial local baseline used Node 24.20.0 and the existing 16-file concurrency:
30,842 tests in 277.622 seconds, with one 40 ms scorecard deadline failure and 17
existing skips. It is a timing observation, not a passing verification result.
The same local machine produced these candidate observations:

| Run | Test seconds | Result |
| --- | ---: | --- |
| Complete ordered suite, 16 workers | 157.397 | One subprocess startup failure |
| Shard 1, 8 workers | 110.855 | Passed |
| Shard 2, 8 workers | 111.213 | One subprocess startup failure |
| Shard 1, 4 workers | 143.198 | Passed |
| Shard 2, 4 workers | 153.209 | Passed, 17 existing skips |

Four workers passed both shards: 30,836 passed tests, 17 skips, zero failures or
cancellations. It is the default for local full runs and each CI shard. The larger
settings missed existing 5- or 15-second subprocess startup deadlines; the signal
fixture passed alone in 1.245 seconds. No deadline or assertion was relaxed.

The two final local shards ran sequentially to avoid machine contention. Their
combined test time was 296.407 seconds. On separate runners the longer shard is
153.209 seconds before setup, builds and other checks. These are individual
samples, not a median or tail-latency claim. Hosted CI evidence is recorded with
the pull request.
The duplicate shard setup/build cost must be included when comparing runner
minutes. Preview deployment and the browser job can still determine total PR time.
