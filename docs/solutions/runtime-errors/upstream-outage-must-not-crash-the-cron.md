---
title: An upstream outage must not crash the cron; health owns the alarm
module: seeders
date: 2026-11-01
problem_type: runtime_error
component: background_job
severity: medium
symptoms:
  - "Railway emails 'Deploy Crashed!' for seed-bundle-portwatch-port-activity every 12h tick"
  - "Seeder log ends 'COVERAGE GAPS: 164/174 usable' and the member exits 1"
  - "Ten country panels go blank seven days after ArcGIS starts answering 'Cannot perform query. Invalid query parameters.'"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - service_object
tags:
  - portwatch
  - arcgis
  - railway
  - exit-codes
  - publish-blocked
  - health
  - stale-data
---

# An upstream outage must not crash the cron; health owns the alarm

## Problem

IMF PortWatch's ArcGIS service started rejecting refresh queries
(`invalid_query`, HTTP 200 with an ArcGIS 400 body): 28 of 174 countries
failed to refresh on the 2026-11-01 12:00Z run, and ten of them had no
payload under seven days old.
The seeder correctly kept last-good data and refused to publish an incomplete
canonical set, but it then exited 1. Railway paints any non-zero exit as
CRASHED, so every 12-hour tick sent a "Deploy Crashed!" email for an outage no
redeploy could fix. Separately, once a country's last payload passed seven
days the API returned `available:false`, so its panel went blank even though
the data was still in Redis.

## Symptoms

- `seed-bundle-portwatch-port-activity` red on Railway at every tick.
- Log tail: `COVERAGE GAPS: 164/174 usable; countries without usable payloads:
  AW, BE, BH, BS, BZ, CU, PR, SD, TG, VG`.
- `/api/health` already reported `portwatchPortActivity` as `SEED_ERROR` with
  partial coverage, so the crash email added no information.

## What Didn't Work

- Retrying `invalid_query` alone (#9945) recovers transient rejections but not
  a sustained one; the same countries fail on the retry.
- Refreshing expired countries first (#9953) helps the moment ArcGIS recovers,
  but does nothing while it is down.

## Solution

1. **Classify the outcome, then pick the exit code** (#9959). The seeder's
   `classifyPublicationBlock` in `scripts/seed-portwatch-port-activity.mjs`
   names two upstream outcomes — `rotation_incomplete` (refreshes failed but
   every country still covered) and `coverage_shortfall` (a country fell out
   of coverage). Both exit `PUBLISH_BLOCKED_EXIT_CODE` (76) after last-good is
   retained and the failure is written to seed-meta. `main()` still exits 1
   for its own faults: an aborted run, unconfirmed canonical retention,
   Redis/cache failures.
2. **The bundle runner maps 76 to exit 0** (`scripts/_bundle-runner.mjs`,
   `PUBLISH_BLOCKED` status, #6396) and prints
   `publish-blocked section(s) preserved last-good and wrote no seed keys —
   exiting 0; the freshness monitor owns the alarm`.
3. **Serve old data labelled instead of blanking it** (#9969).
   `server/worldmonitor/intelligence/v1/get-country-port-activity.ts` keeps
   the 7-day *current* boundary (it must equal the seeder's
   `PORTWATCH_MAX_CACHE_AGE_MS`) and adds a 30-day *serve* boundary
   (`PORTWATCH_PORT_ACTIVITY_MAX_SERVE_AGE_MS`, one `tankerCalls30d` window).
   Between the two the response carries `stale: true` and the Country Deep
   Dive shows "Out of date: IMF PortWatch has not updated this country for
   over a week."

Verified in production on 2026-11-01: the 12:00Z tick on the #9959 build
ended `publish_blocked:1 … exiting 0` and Railway showed `EXITED`, not
`CRASHED`; after #9969 deployed, the live API returned Puerto Rico, the
British Virgin Islands and Aruba as `available:true, stale:true`.

## Why This Works

A crash alert is for a fault someone can fix by changing code or redeploying.
An upstream outage is an expected state: the seeder already preserved data
and recorded the failure, and `/api/health` already alarms on it. Exiting 76
keeps the distinction machine-readable (the bundle logs `PUBLISH_BLOCKED`, not
`ok`) without double-alarming. Health keeps counting a country past seven days
as a coverage gap, so serving its last figures to users does not hide the
outage from operators.

## Prevention

- When a seeder refuses to publish because of upstream state, exit
  `PUBLISH_BLOCKED_EXIT_CODE`, not 1. Reserve exit 1 for faults in our own
  code, storage, or invariants.
- Pin the classification with tests on both sides: the seeder's outcome →
  exit code (`tests/portwatch-rate-limit-rotation.test.mjs` asserts
  `classifyPublicationBlock` returns `PUBLISH_BLOCKED_EXIT_CODE`) and the
  runner's exit code → bundle exit (`tests/bundle-runner.test.mjs`).
  `tests/portwatch-publication.test.mts` runs the real seeder, then reads
  through the real API handler, to pin the 7-day/30-day serving boundaries.
- Keep "current" (drives health) and "servable" (drives the UI) as two
  separate boundaries. A single freshness constant used for both forces a
  choice between a silent alarm and a blank panel.
- Probing the live RPC: GET query params are snake_case
  (`?country_code=PR`); `countryCode=` is silently ignored and returns the
  empty response.

## Related

- [ArcGIS pagination offset must advance by returned rows](../integration-issues/arcgis-pagination-offset-must-advance-by-returned-rows.md)
- [MCP freshness ignored seed-meta error status](../logic-errors/mcp-freshness-ignored-seed-meta-error-status.md)
