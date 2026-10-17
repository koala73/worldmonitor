---
title: "IOM DTM country-list advertises a country its per-country endpoints refuse, one 204 aborted the daily run"
module: displacement seeder (scripts/seed-dtm-displacement.mjs, health bundle)
date: 2026-10-13
category: integration-issues
problem_type: integration_issue
component: background_job
severity: medium
symptoms:
  - "/api/health reported dtmDisplacement STALE_SEED (seedAgeMin 5956 against maxStaleMin 2880) while the health bundle stayed green on Railway"
  - "Every daily bundle tick logged FETCH FAILED: DTM admin1?Admin0Pcode=BDI&FromReportingDate=2025-04-01: No Country Code found matching your query. then === Failed gracefully === (exit 75, TTL extended, nothing republished)"
  - "diagnose-railway-seeders classified seed-bundle-health as HEALTHY (with warnings) because the bundle runner exits 0 on a graceful member skip"
root_cause: missing_validation
resolution_type: code_fix
related_components: [service_object, testing_framework]
tags: [dtm, iom, displacement, health-bundle, stale-seed, graceful-failure, per-country-skip, upstream-inconsistency, seed-freshness]
---

# IOM DTM country-list advertises a country its per-country endpoints refuse, one 204 aborted the daily run

## Problem

The daily DTM displacement seed stopped publishing on 2026-10-10 and `/api/health` flipped `dtmDisplacement` to `STALE_SEED` once the seed passed its 48 h budget. IOM DTM's `country-list` had started advertising Burundi (`BDI`) while every per-country endpoint answered an error envelope for it, and `fetchDtmDisplacement` treated that one refused country as a fatal query error for the whole 54-country run. Fixed in PR #9130 (opened 2026-10-13, unmerged as of this writing).

## Symptoms

- Compact health (`/api/health?compact=1`) listed `dtmDisplacement: { status: STALE_SEED, records: 31, seedAgeMin: 5956, maxStaleMin: 2880 }`. The data itself was intact: 31 operations from the last good run on 2026-10-09.
- The `seed-bundle-health` deployment logs on Railway showed the member failing identically on every tick: `FETCH FAILED: DTM admin1?Admin0Pcode=BDI&FromReportingDate=2025-04-01: No Country Code found matching your query.`, `Extended TTL on 2 key(s)`, `=== Failed gracefully ===`, then `[Bundle:health] 1 graceful fetch skip(s), no hard failures, exiting 0`.
- Because the bundle exits 0, Railway showed the service green and `diagnose-railway-seeders` reported `HEALTHY (with warnings)`. The only honest signal was the seed-meta age in Redis.

## What Didn't Work

- **Reading the Railway triage table as the verdict.** It says "no faults needing action" for a bundle whose member fails every tick. The member's `FETCH FAILED:` line in the bundle log is the evidence, not the exit code.
- **Assuming the cron had stopped ticking.** The last 12 deployments were all `SKIPPED` push deploys, which looks like a dead cron. Fetching a deeper history (80 deployments) showed real `SUCCESS` runs whose log streams spanned several hourly `Starting Container` ticks. `SKIPPED` rows are Watch Paths noise, not missed ticks.

## Solution

A live probe of all 54 listed countries showed 53 answering `isSuccess: true` (22 with rows, 31 with a clean `statusCode 204` "No matching data") and only `BDI` answering `isSuccess: false`. `admin1`, `admin0`, and `CountryName=Burundi` all refuse it the same way, with `statusCode 204`.

A per-country 204 envelope is "no data for this country", whatever `isSuccess` says. `dtmGet` tags it, and the per-country loop skips that country with a warning instead of aborting:

```js
// scripts/seed-dtm-displacement.mjs (dtmGet)
if (body?.isSuccess !== true) {
  const err = nonRetryable(`DTM ${path}: ${(body?.errorMessages ?? []).join('; ') || 'isSuccess=false'}`);
  err.noContent = Number(body?.statusCode) === 204;
  throw err;
}

// fetchDtmDisplacement, per-country worker
try {
  rows.push(...await dtmGet(`admin1?Admin0Pcode=${pcode}&FromReportingDate=${from}`, apiKey));
} catch (err) {
  if (!err?.noContent) throw err;
  console.warn(`  WARN: DTM lists ${pcode} but refuses its admin1 query, skipping: ${err.message}`);
}
```

A non-204 `isSuccess: false` (a bad parameter) still aborts, and a run where every listed country is refused yields zero operations, which `validate` rejects against `MIN_OPERATIONS`, so a broken query shape still cannot publish.

Production was healed the same hour by running the patched seeder by hand (`node scripts/seed-dtm-displacement.mjs` with the linked `.env.local`): 31 operations, 18,100 rows, 3.8 s, and the health probe dropped `dtmDisplacement`. The deployed bundle keeps failing gracefully until the fix deploys, which only extends TTLs, so the manual seed holds for the 48 h budget.

## Why This Works

The seeder's strictness was deliberate (the original test asserted "fails when DTM rejects a query instead of dropping the country") on the assumption that a listed country is always queryable. DTM broke that assumption upstream. Distinguishing the envelope by `statusCode` keeps the strict behavior for genuine query errors while tolerating the registry inconsistency, and the existing operations floor still catches a run that silently lost everything.

## Prevention

- **Per-item upstream errors must not abort a multi-item fetch.** When a seeder fans out over a list the same API returned, treat a per-item "no data" answer as empty for that item and keep a floor on the aggregate. Encode the floor (`MIN_OPERATIONS`, `emptyDataIsFailure`) so the lenient path cannot publish an empty payload.
- **Graceful exit 75 inside a bundle is invisible to Railway and to the triage tool.** When a bundle member's seed-meta ages past its budget, pull the bundle's log and grep for the member's `FETCH FAILED:` line before trusting any green status.
- **Regression tests** in `tests/dtm-displacement-seed.test.mjs`: a listed country answering 204 is dropped and the rest publish; a non-204 refusal still throws; an all-refused run yields zero operations and fails `validate`.
- After a manual seed, the bundle's `seed-completion:displacement:dtm` no longer matches the envelope `fetchedAt`, which the interval gate reads as "due", so the next tick re-runs the member rather than skipping it for 24 h.

## Related

- PR #9130 (the fix), issue #9014 (the seeder's introduction, PR #9015)
- `docs/solutions/integration-issues/gb-tesco-anti-bot-blocked-both-scrape-and-fallback-providers.md` for the sibling lesson that a green provider status is not data freshness
