---
title: "A prefetched request keeps its abort budget only if the budget moves with it"
date: 2026-10-15
category: performance-issues
module: Dashboard boot (src/main.ts, src/services/bootstrap.ts, src/services/bootstrap-prefetch.ts)
problem_type: performance_issue
component: frontend_stimulus
severity: medium
symptoms:
  - "After moving the fast bootstrap tier request from App.init() into the entry script, CI's 'a fast-tier abort keeps its fallback' e2e failed: the held response never aborted and the earthquakes fallback count stayed 0"
  - "After charging the budget from the request start, CI's 'a complete tier pair answers repeat loaders with zero refetch' failed: earthquakes refetched once"
  - "Both passed on a fast local machine and failed only on slower CI runners serving the Vite dev server"
root_cause: async_timing
resolution_type: code_fix
tags: [bootstrap, prefetch, abort-budget, fast-tier, e2e, timing, ci-only-failure]
---

# A prefetched request keeps its abort budget only if the budget moves with it

## Problem

PR #9152 started the fast bootstrap tier from `src/main.ts` so the first data no longer waited for the ~900 KB App chunk. `fetchBootstrapData()` adopted the in-flight request. Its 1.2 s abort budget still started when App asked for the tier, which broke two e2e contracts on CI in two different ways.

## Symptoms

- With the timer started at App time, a primed request could live for the App load time plus 1.2 s. The "fast-tier abort" scenario holds the response for deadline + 1.5 s, so on a slow runner it arrived before the abort, and the fallback never ran.
- With the timer charged from the request start, App loading after 1.2 s left a 0 ms budget. The abort then raced the body read of a response that had already arrived. Chrome's body read crosses a task boundary, so the 0 ms timer won, the data was thrown away, and the fallback refetched.

## What Didn't Work

- **Reproducing with Node unit tests.** Node reads a buffered `ReadableStream` body within microtasks, so a 0 ms abort timer never wins the race there. The unit test passed while CI failed. The race only shows in a real browser.
- **Running the e2e locally as-is.** The local dev server loads App in well under 1.2 s, so neither failure appeared.

## Solution

Charge elapsed time against the budget only while the primed request still awaits a response. Once headers arrive, the body read gets its own 1.2 s allowance from the moment boot adopts the response.

```ts
// bootstrap-prefetch.ts
response.then(() => { entry.respondedAt = performance.now(); }, () => undefined);

export function primedBootstrapTierBudgetUsedMs(): number {
  if (!primed || primed.respondedAt !== null) return 0;
  return performance.now() - primed.startedAt;
}

// bootstrap.ts (fetchBootstrapData)
const fastTimeout = setTimeout(
  () => fastCtrl.abort(),
  Math.max(0, fastBudgetMs - primedBootstrapTierBudgetUsedMs()),
);
```

The adopted request links the caller's signal to the primed `AbortController`, so the timeout still bounds it. A primed request that failed on the network before App loaded gets one direct retry within the same budget.

## Why This Works

Before the prefetch, one 1.2 s timer covered the whole fetch, headers and body, and it started when App asked. After the prefetch the budget has two parts:

- **Waiting for headers** is limited to 1.2 s from the primed request's start. A server that has not answered by then is abandoned, as before.
- **Reading the body** gets a separate 1.2 s allowance, counted from when `fetchBootstrapData()` adopts the response. A primed request can therefore succeed more than 1.2 s after `startedAt`, as long as its headers arrived within the first 1.2 s.

The separate allowance exists because the body may already sit in the browser buffer while App loads. Aborting it would discard complete data. Boot still waits at most 1.2 s after it asks for the tier, the same bound as before.

## Prevention

- When a request moves earlier on the timeline, re-derive every timer keyed to it. Decide which phases count against the budget: waiting for headers, reading the body, or the consumer's wait.
- Reproduce CI-only timing failures in a real browser by slowing the step that differs on CI. Here, `page.route('**/src/App.ts*', ...)` delayed the App module by 1.5 s in the e2e, which reproduced the refetch exactly. Shrinking the abort scenario's margin from 1.5 s to 50 ms reproduced the first failure, and disabling only the prime was the control.
- The unit test `tests/bootstrap-fast-tier-prefetch.test.mts` pins the accounting directly, since Node cannot lose the body-read race: an answered request has used 0 ms of budget, and a pending one is charged its time in flight.

## Related

- `e2e/bootstrap-hydration-request-budget.spec.ts`: the contract that caught both regressions.
- `docs/solutions/performance-issues/cold-dashboard-first-paint-budget.md`: another cold-load budget in the same boot path.
