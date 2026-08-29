---
title: "A negative assertion implemented as a poll-to-exhaustion is both slow and unable to fail"
module: "tests (async pipeline assertions)"
date: 2026-08-29
category: conventions
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Asserting that an async pipeline does NOT emit something (no signal, no callback, no write)"
  - "A test polls or sleeps for a fixed period and concludes absence when nothing arrived"
  - "A test is the slowest in its suite and its cost is a timeout rather than real work"
symptoms:
  - "The test's duration is a round number matching its own poll budget (80 x 25ms = 2000ms), not a measurement"
  - "Absence is concluded by exhausting a wait, so 'the rule rejected it' and 'the pipeline never ran' are indistinguishable"
root_cause: test_isolation
resolution_type: test_fix
related_components:
  - development_workflow
tags: [negative-assertion, positive-control, vacuous-pass, flaky-test, async-timing, test-design, mutation-testing]
---

# A negative assertion needs a positive control, not a timeout

## Context

`tests/dom/keyword-spike-evidence.test.mts` asserted that a term arriving from a single publisher emits **no** spike — the guard for #6428, where a label-keyed source count let one newsroom raise a "4 different news sources" alert on its own. It was written as:

```ts
await expect(drainSpikeFor(/kelmarq/i)).rejects.toThrow();
```

`drainSpikeFor` polls 80 times at 25ms. The only way it can report "no signal" is to **exhaust all 80 attempts**, so the test cost a guaranteed 2000ms — the slowest in the DOM suite, and the next one to fail under load after the transform-billing bug in [x-intel](../test-failures/dynamic-import-in-a-test-body-bills-the-transform-to-testtimeout.md).

The slowness was the visible half. The real defect: a fixed-duration wait cannot distinguish

- **"the gate rejected it"** — what the test means to prove; from
- **"the pipeline had not reached it yet"** — which produces the same silence.

So the test would have stayed green **if ingest broke entirely**. An absence assertion with no positive control asserts nothing.

## Guidance

**Do not shorten the timeout.** It is the obvious cheap fix and it makes things strictly worse: it keeps the vacuous-pass hole and makes it *more* likely to fire, because under load "not emitted yet" starts reading as "correctly suppressed." A slow test that cannot fail becomes a fast test that cannot fail.

**Add a positive control that shares the deciding pass.** Ingest, in the *same* batch, a companion input that **must** produce the thing you are asserting is absent. Wait for the control. Its arrival proves the pipeline ran; the target's absence is then a verdict rather than a race.

```ts
ingestHeadlines([
  // Kelmarq: five Reuters DESKS — one publisher, five feed labels. Must be rejected.
  { source: 'Reuters World', title: 'Ports brace for Kelmarq tariff review', /* ... */ },
  // ... 4 more Reuters desks ...

  // Tessaline: the positive control. Same count and shape, three DISTINCT
  // publishers, so it must spike.
  { source: 'Reuters', title: 'Ports brace for Tessaline levy review', /* ... */ },
  { source: 'AP',      title: 'Growers protest Tessaline levy schedule', /* ... */ },
  { source: 'BBC',     title: 'Retailers model Tessaline levy costs', /* ... */ },
  // ... 2 more across AP/BBC ...
]);

const seen = await drainSpikesUntil(/tessaline/i);
expect(spikeTermsIn(seen, /kelmarq/i)).toEqual([]);
```

**Verify the control actually shares the deciding step** — this is what makes the proof valid rather than merely plausible. Here, `ingestHeadlines` runs `checkForSpikes()` **synchronously** and the publisher gate `continue`s inside it (`src/services/trending-keywords.ts:410`), so a rejected term never reaches the async `handleSpike` at all. Both terms are therefore decided by one synchronous pass, and the control's signal landing proves that pass ran. A control that took a *different* code path would prove nothing about the target.

**Fail loudly if the control stops working.** `drainSpikesUntil` throws with the terms it saw when the control never spikes, so a broken control surfaces as an error rather than a quiet pass.

## Why This Matters

An absence assertion is worth exactly what it costs to make it fail. Without a control it is indistinguishable from `expect(true).toBe(true)` that happens to take two seconds — and it degrades in the worst direction, becoming *more* likely to pass spuriously exactly when the system is under stress.

The cost fix is a side effect of the correctness fix: **2110ms -> 27ms** (78x), and the test left the >300ms tier of the suite entirely.

## When to Apply

Any test whose assertion is "X does not happen" in an async system. The tell is a duration that matches the test's own wait budget rather than measured work — a round 2000ms, 5000ms, or exactly the `testTimeout`.

It does **not** apply where the wait *is* the assertion — `sidecar-readiness > returns false when the sidecar never answers within the timeout` is legitimately testing timeout behaviour, and its ~400ms is the subject, not overhead.

## Examples

**Prove the guard still catches the regression, by mutation.** An absence assertion that is never seen to fail has not been validated. Two mutations were run, since one control can leave a gap:

| mutation | expected | result |
|---|---|---|
| publisher-family counting replaced with label-keyed counting (**the actual #6428 regression**) | red | `expected [ 'kelmarq' ] to deeply equal []` — 34ms |
| `MIN_SPIKE_SOURCE_COUNT` 2 -> 1 (**gate removed entirely**) | red | `expected [ 'kelmarq' ] to deeply equal []` — 32ms |

Both mutations were reverted and `git status` confirmed the diff was the test file only. Note the failures now arrive in ~30ms naming the problem, instead of surfacing as a 2s timeout.

**Before / after, in shape:**

```ts
// Before — 2000ms, and green even if ingest is dead.
await expect(drainSpikeFor(/kelmarq/i)).rejects.toThrow();

// After — 27ms, and red the moment the gate stops working.
const seen = await drainSpikesUntil(/tessaline/i);   // positive control
expect(spikeTermsIn(seen, /kelmarq/i)).toEqual([]);  // the absence, now provable
```

Fixed in PR #7351.
