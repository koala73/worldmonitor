---
title: Deterministic timestamps for GDELT bulk fallback fixtures
date: 2026-07-14
category: test-failures
module: GDELT conflict-event fallback
problem_type: test_failure
component: testing_framework
symptoms:
  - "CI unit tests failed after static bulk-export timestamps crossed the 24-hour rolling cutoff"
root_cause: logic_error
resolution_type: test_fix
severity: medium
tags: [gdelt, rolling-window, deterministic-tests, fixtures]
---

# Deterministic timestamps for GDELT bulk fallback fixtures

## Problem

Three GDELT bulk-fallback tests failed in CI even though the production fallback was behaving correctly. Their mock export timestamp was fixed at `20260713110000`, but the tests used the wall clock when evaluating the rolling window.

## Symptoms

- The `unit` job on PR #5314 rejected the mocked bulk events with `rolling bulk window contained no priority-country material-conflict events`.
- The same three tests reproduced locally once the wall clock was more than 24 hours after the mocked export timestamp.

## What Didn't Work

- Re-running the tests without changing the fixture did not help: the cutoff moves with `Date.now()`.
- Changing the production stale-event filter would have hidden a valid safety check rather than fixing the test input.

## Solution

Inject a deterministic clock into every test that supplies the static bulk export fixture:

```js
const BULK_FIXTURE_NOW = Date.parse('2026-07-13T12:00:00Z');

const result = await fetchGdeltConflictEvents({
  now: () => BULK_FIXTURE_NOW,
  fetchBulkEvents: async () => ({
    exportTimestamp: '20260713110000',
    events: [{ id: 'gdelt-event-empty-doc', country: 'Sudan' }],
  }),
});
```

This change is in `tests/conflict-gdelt.test.mjs`; production code remains unchanged.

## Why This Works

The rolling merge uses `gdeltAddedAt` when an event provides it, otherwise it falls back to the export timestamp. It then excludes entries older than its 24-hour cutoff ([scripts/_conflict-gdelt-bulk.mjs](../../../scripts/_conflict-gdelt-bulk.mjs#L179-L196)). A fixed `now` keeps the intentionally static fixture inside that window, making the fallback-contract test independent of when CI runs.

## Prevention

- Inject `now` whenever a test combines a static timestamp fixture with rolling-window or freshness logic.
- Keep expiry behavior in a separate test with an explicitly advanced injected clock; do not rely on wall-clock time to exercise it.

## Related Issues

- [PR #5314](https://github.com/koala73/worldmonitor/pull/5314) contains the CI repair and passed all required checks.
