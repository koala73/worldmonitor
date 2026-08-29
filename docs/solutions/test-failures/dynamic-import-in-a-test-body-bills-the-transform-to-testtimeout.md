---
title: "A dynamic import inside a test body bills the module transform to that test's testTimeout"
module: "tests/dom (vitest DOM suite)"
date: 2026-08-29
category: test-failures
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "One test in a file fails with a timeout under load while its siblings in the same file pass in 1-3ms"
  - "The file passes 4/4 in isolation on the same tree, so the failure looks like flake rather than a defect"
  - "A single timeout reports as TWO failures: the timed-out test's late promise resolution lands during the next test, tripping an unrelated `expected not to be called` assertion"
  - "The failure names a file unrelated to whatever change is being pushed, and can red a pre-push hook"
root_cause: async_timing
resolution_type: test_fix
related_components:
  - development_workflow
  - tooling
tags: [vitest, testtimeout, dynamic-import, module-transform, false-red, flaky-test, dom-tests, pre-push]
---

# A dynamic import inside a test body bills the module transform to that test's testTimeout

## Problem

`tests/dom/x-intel-data-loader.test.mts` timed out under load while the other three tests in the same file finished in 1-3ms, and passed 4/4 whenever it ran alone. The cost was not in the assertions — it was the `@/app/data-loader` module graph being transformed inside the first test's `testTimeout`.

## Symptoms

- `hydrates immediately and ignores a late live result after teardown` at **15026ms** (the configured `testTimeout`), siblings at 3ms / 1ms / 1ms.
- Passes in isolation; fails only in a full-suite run on a loaded machine.
- Reports as two failures, not one — see *Why This Works* for the cascade.
- Reproduced with the machine at load average 36.6 with 107 node processes; blocked an unrelated billing push at the pre-push gate.

## What Didn't Work

- **Re-running.** The file passes alone and often passes in the suite, so re-running "proves" nothing and buries the defect. `#6677` explicitly says not to close this class by re-running until green.
- **Attributing it to the change under test.** The file has nothing to do with billing; the first instinct was that the branch caused it. It did not — the branch merely added one more DOM test file, which was enough extra parallel load to tip an already-marginal test over.
- **Blaming machine load alone.** Load is the trigger, not the cause. A test that spends 1637ms of a 15000ms budget on module transform is one contended machine away from red *by construction*.
- **Raising `testTimeout`.** This is what `#6677` already did (5000ms -> 15000ms). It buys headroom and hides that a test takes seconds. The budget is not the problem; what is being billed to it is.

## Solution

Import the heavy module graph once at **module scope**, so its transform lands in the file's import phase — which vitest does not bill to any `testTimeout` — and the in-test `await import()` calls become cache hits.

```ts
vi.mock('@/services/panel-gating', async (importOriginal) => ({ /* ... */ }));

// #6677: the first test in this file used to pay for the data-loader module
// graph's transform inside its testTimeout, because every case reaches the
// graph through an `await import()` in the test body and the first one to run
// bears the cost. Importing at module scope moves the transform into the
// file's import phase, which vitest does not bill to any testTimeout.
await import('@/app/data-loader');

describe('X feed DataLoader lifecycle', () => {
  it('...', async () => {
    const { DataLoaderManager } = await import('@/app/data-loader'); // now a cache hit
```

Measured on the same machine:

| | before | after |
|---|---|---|
| first test | 1637ms | 6ms |
| `tests` total | 1.64s | 12ms |
| `import` phase | 48ms | 2.16s |

The cost did not disappear — it moved out of the timed region. The timed portion dropped ~270x, so the test now needs orders of magnitude more load than exists to reach the budget.

## Why This Works

vitest's `testTimeout` covers the test body. A `await import()` written **inside** `it(...)` therefore charges the module-graph transform — `data-loader.ts` plus the i18n locale glob and generated clients — to whichever test runs first. Only the first pays; the rest hit the module cache, which is exactly the "one slow test, siblings instant" signature.

Moving the import to module scope shifts it into the collection/import phase, which is not billed to a test. `vi.mock` calls are hoisted above imports by vitest's transform, so a module-scope import still receives the mocks.

**The two-failure cascade.** With `isolate: true`, each *file* gets a fresh environment but tests within a file share one. When test 1 times out, its in-flight deferred promise still resolves afterwards — during test 2 — so test 2 fails with `expected "vi.fn()" to not be called at all, but actually been called 1 times`. One root cause, two red tests, and the second one points somewhere misleading.

## Prevention

**Diagnostic — how to spot this in any suite.** Run the file alone with per-test durations and compare the first test against its siblings:

```bash
npx vitest run --config vitest.dom.config.mts <file> --reporter=verbose
```

A **first-test-only spike** with siblings at ~1ms means transform cost is being billed to the test, not real work. Contrast with a *mid-file* slow test alongside static top-level imports, which indicates genuine async work and needs a different fix.

**Sweep, don't spot-fix.** After fixing one file, profile the whole suite for the same shape rather than assuming it was unique:

```bash
npx vitest run --config vitest.dom.config.mts --reporter=verbose 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^\s+[✓×] tests/" \
  | awk '{n=$NF; sub(/ms$/,"",n); if (n+0 >= 300) print n"ms\t"$0}' | sort -rn
```

That sweep is what found the *next* worst offender, which had a different root cause entirely — see [proving a negative assertion with a positive control](../conventions/a-negative-assertion-needs-a-positive-control-not-a-timeout.md).

**The established idiom already existed.** `firms-timeout-lock-recovery`, `global-procurement-data-loader` and `data-loader-digest-coverage` all carry this module-scope warm-up, and `#6677` applied it to `story-data-cached-cii` and `fx-panel-data`. x-intel was simply the data-loader test that missed it. When adding a DOM test that reaches a heavy graph through `await import()`, copy the warm-up alongside it.

**Do not close this class by re-running.** Per `#6677`: a green CI run only means the runner happened to be fast enough. CI green is not evidence the test is sound.

Fixed in PR #7350.
