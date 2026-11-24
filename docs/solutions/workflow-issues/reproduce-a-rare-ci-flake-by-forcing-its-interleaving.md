---
title: "Reproduce a rare CI flake by forcing its interleaving, not by slowing the machine"
date: 2026-11-24
category: workflow-issues
module: ci-flaky-tests
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - "A test failed once or twice in CI and passed on re-run"
  - "Local repeat runs and CPU throttling do not reproduce it"
  - "The failure is a timeout, a missing element, or a closed page rather than a wrong value"
tags: [flaky-test, ci-health, reproduction, playwright, happy-dom, race, timer, route-stall]
---

# Reproduce a rare CI flake by forcing its interleaving, not by slowing the machine

## Context

On 2026-11-24 four CI-health flakes were fixed together: #11173, #11159, #11158 and #11174. Each had failed once or a few times and passed on re-run. Slowing the machine reproduced none of them:

- **#11173.** 16 CPU burners: 0 failures in 45 runs.
- **#11159.** Chrome CPU throttled 6x and 20x: 0 failures in 50 runs.
- **#11174.** CDP CPU throttling at 6x: 0 failures in 10 runs.

Each failure came from one specific event landing at one specific moment. A slower machine makes that more likely only by chance.

Earlier triage on two of these issues guessed at the cause from the error text, and both guesses were wrong. #11173 blamed a 100-turn spin limit. #11158 blamed a browser crash. Both were refuted with evidence.

## Guidance

1. **Read the CI trace before you guess.** Download the Playwright artifact (`gh run download <run-id>`) and read the trace events around the failing step. For a re-run that passed, fetch attempt 1 explicitly. The run's conclusion is `success`, so a scan of failed runs alone misses it.
2. **Name the event that must land in the window.** The trace or the logged test durations usually show which timer, network response or chunk load arrived at the wrong moment.
3. **Force that event deterministically.**
   - For a timer, hold it from a preload and fire it when the vulnerable state exists.
   - For a network response, route the request to a handler that never answers.
   - For a lazy chunk, delay its module request.
   - For a re-render, trigger it explicitly between the two steps it raced.
4. **Run a control that differs in one dimension.** Run the same pair of tests without the forcing, and the forced trigger with the victim test alone. Both must pass on unfixed code, or the forcing created the bug.
5. **Count both sides.** Before the fix, the forced trigger should fail every run. After the fix, it should pass every run, and you should log that the trigger fired, so a pass is not a missed trigger.

## Why This Matters

A fix verified only by "it didn't fail in N natural runs" proves nothing when the natural failure rate is near zero. Each of the four fixes was proven by a trigger that failed 100% before the fix and passed 100% after.

Forcing the interleaving also decides whether the bug is in the test or the app. One of the four (#11159) was a real app bug that users could hit, not a test race.

## When to Apply

- A CI-health issue (`scripts/check-ci-health.mjs`) reports a test that failed, then passed on the same commit.
- The failure is "element not found", "expected 1, received 50", "Target page, context or browser has been closed", or a hook timeout.

## Examples

**Held timer (#11173, PR #11233).** `tests/pro-checkout-feedback.test.mts` failed `assert.ok(chooser())`. Checkout removes its "Opening checkout" overlay with a real 200 ms `setTimeout`, and an earlier test left one pending. The forced repro was a preload that holds that timer until a later test has the chooser open, then fires it. The timer woke a `MutationObserver` that the earlier test's fixture had attached. `happyDOM.abort()` does not disconnect observers, and the observer clicked the later test's chooser away through the global `document`. Result: 20 of 20 runs failed before the fix and 20 of 20 passed after. The fix disconnects the observer in `afterEach`.

**Stalled route (#11158, PR #11236).** `e2e/rag-vector-store.spec.ts` reported `Target page, context or browser has been closed` after 0 ms. The first error in the log was the `beforeAll` hook timeout. The trace showed the Hugging Face model response with headers received and the body never completed. The crash reporter counted 0 crashes. The forced repro routed the model request to a handler that never answers, which reproduced the same two errors. The fix serves the model from a CI cache and fails the hook on any off-host request.

**Forced re-render (#11159, PR #11234).** `e2e/stock-stored-coverage.spec.ts` expected 1 filtered row and got 50. The trace showed the panel's content replaced in the middle of `fill`. Chrome fires `blur` on a focused input while `innerHTML` replacement removes it, and that blur cleared the flag `WatchlistTableView` uses to restore focus. The forced repro focuses the search box, triggers a refresh that reorders the rows, then types. Result: 10 of 10 failed before the fix and 50 of 50 passed after. The fix is in `src/components/WatchlistTableView.ts`. A blur clears the flag only when the input is still in the document after a microtask, and the restore never takes focus from another element.

**Delayed chunk (#11174, PR #11238).** In `e2e/dashboard-wide-layout.spec.ts` the drag start never set `panel-drag-active`. The trace showed the targeted header belonged to the Live News deferred shell, which has `pointer-events: none`. The forced repro delayed the Live News chunk by 4 s. Result: 6 failed before the fix and 30 of 30 passed after. The fix excludes `[data-deferred-panel]` from the helper's selector.

## Related

- `docs/solutions/test-failures/flake-fix-traded-away-by-a-later-pr.md`. A timing flake whose earlier fix was undone later.
- Issues #11158, #11159, #11173, #11174.
