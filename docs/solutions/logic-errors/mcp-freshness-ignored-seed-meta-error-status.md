---
title: MCP freshness ignored seed-meta error status that /api/health reports as SEED_ERROR
date: 2026-10-18
category: logic-errors
module: mcp-freshness
problem_type: logic_error
component: service_object
symptoms:
  - "MCP tool responses reported `stale: false` for data that /api/health classified as SEED_ERROR"
  - "A failed relay refresh writes seed-meta with a fresh fetchedAt and status 'error' while the last good payload stays served, so an age-only check passes"
  - "Latent at maxStaleMin 30 for get_social_velocity; the window grew to 9 hours when #9336 raised the budget to 540"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [background_job, testing_framework]
tags: [mcp, freshness, seed-meta, health-parity, seed-error, social-velocity, evaluatefreshness, stale]
---

# MCP freshness ignored seed-meta error status that /api/health reports as SEED_ERROR

## Problem

The MCP freshness envelope and `/api/health` read the same seed-meta record and disagreed about it. `evaluateFreshness` in `api/mcp/freshness.ts:24` sets each tool response's `stale` flag. Before PR #9336 it compared `fetchedAt` age with `check.maxStaleMin` (`api/mcp/freshness.ts:54`), plus the optional `minRecordCount`, `honorContentAge` and `requireContentFreshness` dimensions. It never read `meta.status`.

Health does read it. `readSeedMeta` returns `seedStale: true, seedError: true` when `meta?.status === 'error'` (`api/health.js:2980-2985`), and `classifyKey` turns `seedError` into the `SEED_ERROR` fault (`api/health.js:3391`).

Producers write failure meta with a fresh `fetchedAt` and `status: 'error'` while the previous payload stays in Redis. `writeSocialVelocityFailureMeta` in `scripts/ais-relay.cjs` writes `{ fetchedAt: Date.now(), recordCount: 0, status: 'error', ... }` to `seed-meta:intelligence:social-reddit`. On an empty fetch or a thrown error the relay also re-extends the data key's TTL, so last-good data keeps serving. Health calls that state SEED_ERROR. MCP saw a recent `fetchedAt` and answered `stale: false`.

## Symptoms

- `get_social_velocity` could return `stale: false` while `/api/health` reported `socialVelocity` as SEED_ERROR for the same key.
- The bug was latent while the tool used `maxStaleMin: 30`. Error meta aged past 30 minutes quickly, so the false-fresh window was short.
- The 30-minute budget caused the opposite symptom. The relay runs every 3 hours (`SOCIAL_VELOCITY_INTERVAL_MS` in `scripts/ais-relay.cjs`), so healthy data read `stale: true` for most of each cycle while health called it fresh.
- PR #9336 corrected the budget to 540 in `api/mcp/registry/cache-tools.ts`, matching `SEED_META.socialVelocity` in `api/health.js`. That widened the false-fresh window after a failed refresh from 30 minutes to 9 hours. CodeRabbit flagged it in an outside-diff review comment on the PR.

## What Didn't Work

The first fix in PR #9336 only changed the budget from 30 to 540. Its tests covered age alone: a 2.5-hour-old seed is fresh, a 10-hour-old seed is stale. Both passed, and MCP still disagreed with health on every failed refresh. Matching one dimension of health's classification is not parity.

The two failure modes cost different amounts. A budget tighter than the producer's cadence produces false stale, which is visible and was the reason the change was made. A correct budget without status parity produces false fresh: the client gets old data labeled current, and nothing alerts. The first fix traded the visible failure for the silent one.

## Solution

One line in `evaluateFreshness`, directly after the age check (`api/mcp/freshness.ts:54-58`):

```ts
    stale ||= (now - fetchedAt) / 60_000 > check.maxStaleMin;
    // A failed refresh stamps a fresh fetchedAt while the last good payload
    // stays served. api/health.js readSeedMeta reads status 'error' as
    // seedStale and classifyKey reports it as SEED_ERROR; MCP follows so the
    // two cannot disagree.
    stale ||= (meta as { status?: unknown }).status === 'error';
```

It runs for every freshness check of every MCP tool, not only `get_social_velocity`.

Tests in `tests/mcp-social-velocity-freshness.test.mjs`:

- The tool's budget equals `__testing__.SEED_META.socialVelocity.maxStaleMin` imported from `api/health.js`.
- A 2.5-hour-old seed is fresh and a 10-hour-old seed is stale.
- A just-failed refresh (`fetchedAt` one minute ago, `status: 'error'`) is stale, and the same record with `status: 'ok'` (and a normal record count) is fresh. Before the fix this test failed with actual `false`, expected `true`.

After the fix the full MCP test set passed (3,270 tests). On 2026-10-18, after deploy, `get_social_velocity` returned `stale: false` for a seed cached about 45 minutes earlier, which the old 30-minute budget would have flagged.

## Why This Works

After a failure write, `fetchedAt` records when the producer last ran, not when the served data was produced. An age check alone cannot tell a successful run from a failed one. Health already treats `status: 'error'` as stale regardless of age; checking `status` gives MCP the same distinction. With the budget also matched, MCP and health classify the same meta the same way on both dimensions.

## Prevention

- When you change a tool's `_freshnessChecks` or a health `SEED_META` budget, pin the parity in a test that imports `__testing__.SEED_META` from `api/health.js`. `tests/mcp-portwatch-content-freshness-parity.test.mjs` is the model, written for #6080 after #4293 closed the same shape on record count.
- Every seed-meta dimension health reads (status, content age and record count, among others) needs a counterpart in `evaluateFreshness`. When health gains one, add it to MCP in the same change and test the case where the two would disagree, not only the case where they agree.
- A budget tighter than the producer's cadence is also a bug. Derive it from the producer interval and match health.
- Test the failure-write path, not only the age path. A producer that stamps fresh meta on failure defeats any age-only check.
- A fleet check does not exist yet: iterate every MCP tool's `_freshnessChecks`, find the health `SEED_META` entry with the same key, and assert the budgets match. It would catch budget drift across all tools at once.

## Related Issues

- [An MCP _freshnessChecks entry for a not-yet-seeded key marks every other dataset in that tool stale](../design-patterns/mcp-freshness-check-for-a-new-key-stales-the-whole-tool.md): the same function, opposite failure (false stale from a missing meta).
- [MCP energy observation audit](mcp-energy-observation-audit.md): a failed seed extends content TTLs without refreshing freshness metadata.
- Issue #5947: a repeated synthesis rejection keeps a stale last-good payload while freshness metadata advances (insights seeder, not MCP).
