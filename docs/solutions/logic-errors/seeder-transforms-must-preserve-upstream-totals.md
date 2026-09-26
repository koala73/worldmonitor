---
title: "Seeder transforms silently changed upstream conflict totals (UCDP cap, HAPI category sum, HAPI period retention)"
date: 2026-09-24
category: logic-errors
module: conflict seeders (UCDP events, HAPI humanitarian summary, UCDP bootstrap projection)
problem_type: logic_error
component: background_job
symptoms:
  - "Redis held Ukraine August 2026 UCDP deaths as 524; the UCDP candidate release says 5,648"
  - "conflict:humanitarian:v1:SA September conflictFatalities read 146, exactly twice the 73 political-violence figure"
  - "HAPI keys held only the newest month, so no HAPI period overlapped UCDP's newest month"
  - "Bootstrap key conflict:ucdp-events-bootstrap:v1 carried a dedupeIndex (58 percent of its bytes) that no code read"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [ucdp, hapi, acled, seeder, invariant, upstream-totals, redis, bootstrap, conflict]
---

# Seeder transforms silently changed upstream conflict totals

## Problem

Three seeder transforms changed the totals that UCDP and HAPI publish. A row cap dropped half of August's UCDP deaths. A category sum double counted HAPI civilian targeting. A retention rule kept one HAPI month. Every check in the pipeline passed, because each transform produced a well-formed payload. The panel total, `get_conflict_events`, CII, CRI, and the public humanitarian REST endpoint all read the wrong numbers.

The rule this doc records: a seeder transform (cap, sum, retention) must preserve the upstream release's totals. Check that invariant against the upstream release itself. Nothing in the pipeline does it for you.

## Symptoms

- UCDP Ukraine August 2026 read 524 deaths in `conflict:ucdp-events:v1`. The candidate release has 5,648. The payload held 1,500 of 1,774 August rows. The 274 dropped rows were dated 08-01 to 08-05 and carried 5,698 of 11,118 August deaths (51 percent). The largest was a Ukraine monthly aggregate of 5,017 deaths, which UCDP dates to the period start.
- HAPI `conflictFatalities` for Saudi Arabia September read 146, from 73 political violence plus 73 civilian targeting. Across August 2026 the sum was 18,279 against 14,191 political-violence fatalities, 29 percent high.
- Every `conflict:humanitarian:v1:<ISO2>` key held only `summary` for the newest month. No month overlapped UCDP, so no cross-source comparison was possible.
- `conflict:ucdp-events-bootstrap:v1` was 131,874 bytes, of which `dedupeIndex` was 76,178 bytes. Its only reader had been deleted.
- None of this raised a health warning. `seed-meta` `fetchedAt` stayed fresh and record counts looked normal (2,000 UCDP rows).

## What Didn't Work

- **Trusting health and record counts.** Seed-meta freshness, row counts, and the 5 MB write guard all passed. They measure whether a write happened, not whether its totals match the source.
- **Trusting the field description.** The HAPI schema said "Total fatalities from political violence and civilian targeting". The code did exactly that. The HAPI documentation states the categories "are not mutually exclusive". In all 468 country-periods pulled from HDX, civilian targeting never exceeded political violence. The description was accurate and the number was still a double count.
- **Newest-first capping as a safe default.** The pre-#8587 cap kept the newest candidate rows (`candidateKeep = Math.min(candidateEvents.length, maxEvents - annualReserved)`). That looks harmless for event rows. It is not harmless when the source dates monthly aggregates to the first of the month, because those rows sort last and get cut first.
- **Declaring fixed at merge.** At 07:24 UTC all four PRs had merged and production data was unchanged. The UCDP writers gate at 6 h and the HAPI refresh at 2 h, so the first fixed writes landed at 08:46 UTC (HAPI) and 12:03 UTC (UCDP).
- **Deleting a reader without auditing its writer.** #8588 removed `deduplicateAgainstAcled` and `deduplicateUcdpProjectionAggregates` and their file `src/services/conflict/ucdp-dedupe.ts`. It left `buildUcdpDedupeIndex` in `scripts/_ucdp-dashboard.mjs` writing the index into every bootstrap publish. After #8587 raised the row count to 2,306, that dead index would have pushed the key past the 130,821-byte `ucdpEvents` budget (`scripts/_bootstrap-payload-budget.mjs:120`) plus its growth allowance.

## Solution

Five merged PRs.

**#8587, UCDP cap.** `capWithAnnualFloor` now keeps every candidate row and grows capacity to fit them plus the annual floor (`scripts/shared/ucdp-candidate.cjs:117-131`):

```js
const annualReserved = Math.min(annualEvents.length, annualFloor);
const capacity = Math.max(maxEvents, candidateEvents.length + annualReserved);
const picked = [
  ...candidateEvents,
  ...annualEvents.slice(0, capacity - candidateEvents.length),
];
```

`MAX_EVENTS = 2000` is now a default capacity, not a hard cap (`scripts/seed-ucdp-events.mjs:32`). Both UCDP writers call the shared function: `scripts/seed-ucdp-events.mjs:292` and `scripts/ais-relay.cjs:3068`. The annual floor stays at 500 rows (`scripts/shared/ucdp-candidate.cjs:34`).

**#8589, HAPI double count.** The aggregate no longer tracks civilian targeting. `conflictFatalities` and `conflictPoliticalViolenceEvents` come from the political-violence category only (`scripts/_conflict-hapi.mjs:377-379` and `scripts/_conflict-hapi.mjs:394-395`). The proto and OpenAPI descriptions now say "Political-violence category fatalities only".

**#8590, HAPI period retention.** `aggregateHapiConflictEvents` keeps one aggregate per country per `referencePeriod` (`scripts/_conflict-hapi.mjs:349-369`). It emits `summary` for the newest period and `previousCompleteSummary` for `previousMonthStart(nowMs)` (`scripts/_conflict-hapi.mjs:386-405`). A missing previous month leaves the field absent, never zero or an older substitute.

**#8588, dedupe removal.** Deleted `src/services/conflict/ucdp-dedupe.ts` and its calls in `src/services/conflict/index.ts` and `src/app/data-loader.ts`. That code resolved UCDP/ACLED overlap by subtracting the UCDP event from the tab totals.

**#8594, dead writer.** Removed `buildUcdpDedupeIndex` and the `dedupeIndex` field from `compactUcdpDashboardPayload` (`scripts/_ucdp-dashboard.mjs:139-151` now ends at `totalEvents`). No reference to `dedupeIndex` remains in `src`, `scripts`, or `server`; the only hit is the test that asserts its absence (`tests/ucdp-dashboard-projection.test.mts:137`).

**Production verification (2026-09-24, read-only Redis GET).**

| Check | Before | After | First fixed write |
| --- | --- | --- | --- |
| UCDP rows in `conflict:ucdp-events:v1` | 2,000 | 2,306 (about 775 KB) | 12:03:37 UTC |
| UCDP August rows / deaths | 1,500 / 5,420 | 1,774 / 11,118 | 12:03:37 UTC |
| Earliest August row | 2026-08-05 | 2026-08-01 | 12:03:37 UTC |
| Ukraine August deaths | 524 | 5,648 | 12:03:37 UTC |
| HAPI SA September `conflictFatalities` | 146 | 73 | 11:46 UTC (HDX recovery) |
| HAPI UA September `conflictFatalities` | 2,130 | 1,969 | 11:46 UTC |
| HAPI UA `previousCompleteSummary` (August) | absent | 4,011, equal to HDX August political violence | 08:46:13 UTC |
| `conflict:ucdp-events-bootstrap:v1` | 131,874 bytes with `dedupeIndex` | 55,798 bytes, no `dedupeIndex`, `totalEvents` 2,306 | 12:03:37 UTC |

The 08:46 HAPI run hit `HDX_TIMEOUT` (`sourceState: degraded`). The seeder fell back to the HAPI JSON API, which returned nothing newer than August. For three hours `summary` and `previousCompleteSummary` were both August, and HAPI was a month stale. The API channel also reported UA August as 3,940, not the HDX 4,011. HDX recovered at 11:46 UTC and restored September plus the exact HDX figures.

## Why This Works

Each defect was a transform that assumed something about the upstream shape that the upstream does not promise.

- The cap assumed rows are interchangeable events, so dropping the oldest drops the least. UCDP candidate releases include monthly aggregates dated to the period start. Keeping the whole candidate release makes the payload's per-month totals equal the release's totals by construction.
- The sum assumed HAPI's event types partition the events. They overlap: civilian targeting is a subset of political violence in every observed row. Reading the parent category alone cannot exceed the parent.
- The retention assumed only the newest month matters. Cross-source comparison needs the month the other source covers. Keeping the previous complete month gives UCDP and HAPI a shared period.
- The dedupe subtracted one source's count whenever another source reported something nearby. That overwrote a published total with a guess. Removing it leaves both source values intact.

## Prevention

**Invariant 1: per-month death totals survive the cap.** For every month in the upstream release, `sum(deathsBest)` in the written payload equals the release's sum. The regression test is `tests/ucdp-candidate-merge.test.mjs:211` ("preserves monthly deaths when a release exceeds the cap and its aggregate starts on day one"). It builds 2,500 candidate rows plus a 5,017-death row dated 08-01, caps them, and asserts the retained candidate deaths are 7,517 and `summarizeUcdpEvents(retained)` equals `summarizeUcdpEvents(candidate)`. Any new cap, filter, or trailing window on a seeder needs the same shape of test: build a fixture where the dropped rows carry the weight, then compare totals before and after the transform.

**Invariant 2: a category sum never exceeds its parent category.** A derived total built from overlapping categories must be less than or equal to the parent category's upstream value. The regression test is `tests/seed-conflict-intel-hapi-circuit-breaker.test.mjs:455`, which feeds 12 political-violence and 4 civilian-targeting events and asserts `conflictPoliticalViolenceEvents` 12 and `conflictFatalities` 3. Before summing categories from any source, read its documentation for "mutually exclusive". If it does not say so, check the data: count rows where the child exceeds the parent. Zero of 468 was the signal here.

Residual: `conflictEventsTotal` still sums every event type, including civilian targeting (`scripts/_conflict-hapi.mjs:376` and `scripts/_conflict-hapi.mjs:393`). The fixture above yields 23 from 12 political violence, 4 civilian targeting, and 7 demonstrations, so the total double counts civilian targeting the same way #8583 did. The proto describes the field as "Total conflict events in the reference period" (`proto/worldmonitor/conflict/v1/humanitarian_summary.proto:13-14`). It was outside #8589's scope and is tracked in #8620.

**Delete a reader, audit its writer.** When a PR removes the last reader of a field, grep for the producer of that field in `scripts/` and the bootstrap projection, and remove it in the same PR. A dead field costs payload bytes and budget headroom on every publish. It also makes the next row-count increase look like a budget regression. #8594 added `tests/ucdp-dashboard-projection.test.mts:149`, which asserts that doubling the event count grows the bootstrap projection by under 2,000 bytes. That test would have caught the dead index growing with the full set.

**Verification recipe for any seeder data fix.**

1. Pull the upstream release and compute the totals you expect (per month, per country, per category). Save the raw input.
2. Before the next scheduled write, run the merged code over the saved input. Load the function from `origin/main` into a scratch copy, rewrite imports to absolute paths, and change nothing in the worktree. Compare its output with step 1. This proves the fix without waiting on a cron.
3. Find the next write time. Check the deploy SHA on the writer service, then the writer's refresh gate (UCDP 6 h, `UCDP_POLL_INTERVAL_MS` at `scripts/ais-relay.cjs:2877`; HAPI 2 h, `HAPI_REFRESH_INTERVAL_MS` at `scripts/seed-conflict-intel.mjs:111`) and any boot delay (`bootSeedDelayMs` in `scripts/ais-relay.cjs`).
4. After that write, read the canonical key and its `seed-meta:*` key with a read-only Redis GET. `seed-meta` `fetchedAt` must postdate the writer's deploy. A read before that proves nothing.
5. Compare the stored values with the upstream totals from step 1, not with the simulated values alone. Record the exact figures in the issue.
6. Check the source channel and degraded state in the same read. A fallback path (here `HDX_TIMEOUT` to the HAPI API) can serve an older period or slightly different figures. Do not call the fix verified from a degraded write. Re-read after the primary source recovers.
7. Re-read any derived key the fix touches (here the bootstrap projection) and compare its size with its budget.

## Related Issues

- #5994 (cross-source conflict detection discovery; found all four defects)
- #8582 (UCDP cap), fixed by #8587
- #8583 (HAPI double count), fixed by #8589
- #8584 (HAPI period retention), fixed by #8590
- #8585 (UCDP-vs-ACLED delete), fixed by #8588
- #8594 (drop dead `dedupeIndex` from the bootstrap projection)
- #8620 (`conflictEventsTotal` still double counts civilian targeting)

## Related Docs

- [Pruned history window undercuts gap detection](pruned-history-window-undercuts-gap-detection.md): the same shape as the UCDP cap. A recency-bounded prune deletes exactly the older-dated records a downstream total needs.
- [Retention that outlives its own alarm](retention-that-outlives-its-own-alarm.md): a transform preserves one half of an invariant and silently breaks the other.
- [Corroboration counts publisher families](../best-practices/corroboration-counts-publisher-families.md): the same abstract error as the HAPI sum. Non-independent parts were counted as if they were additive.
