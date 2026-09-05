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

The complete data-test inventory is discovered on each invocation. Two shards, with four test processes each,
balance estimated file durations; unmeasured files receive a default cost and
still run. The Node test API receives literal files, so a second glob expansion
cannot omit a filename with brackets. Long files start first. Each shard retains
the `/pro` and dashboard builds and `WM_EXPECT_BUILT_OUTPUT=1`. The required `unit`
aggregate rejects failed, cancelled or unexpectedly skipped shards.

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
npm run build:pro
VITE_VARIANT=full ./node_modules/.bin/vite build
WM_EXPECT_BUILT_OUTPUT=1 npm run test:data -- --shard=1/2 --concurrency=4 --timings=/tmp/data-test-timings.jsonl
```

Use `--shard=2/2` for the other half and `--list` to inspect selected files without
running them. Run heavy local checks sequentially. CI uploads each shard's timing
JSONL separately. `scripts/shared/data-test-durations.json` contains estimates for
files measured above five seconds; it controls placement only. Refresh estimates
from successful runs on comparable machines. Do not use reporter row counts as
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
