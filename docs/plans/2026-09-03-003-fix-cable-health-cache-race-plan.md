---
title: "Cable Health Cache Race - Plan"
type: fix
date: 2026-09-03
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-incident-report
execution: code
---

# Cable Health Cache Race - Plan

## Goal Capsule

- Objective: Keep the public cable-health cache positive-only so a transient NGA null cannot expose `cable-health-v1` as empty while the handler publishes its last-good fallback.
- Authority: The incident requirements and root `AGENTS.md` govern this work. Existing NGA negative caching, cable scoring, health thresholds, and production operation remain unchanged.
- Stop conditions: Stop if the fix needs a seeder, grace period, threshold, or production-operation change. The response must complete fallback and seed metadata publication before it returns.
- Tail ownership: Deliver the existing pull request ready for review. Do not merge, enable auto-merge, request reviewers, post comments, or run production seeders.

## Product Contract

### Summary

The cable-health handler must serve its last usable snapshot through a transient NGA null without making the public Redis key negative or allowing health metadata to lag the served response.

### Problem Frame

The inner NGA cache correctly uses a negative sentinel and short backoff when the upstream fetch fails. The outer computed cache also receives `null` and writes its own negative sentinel. The handler then starts public-key and seed-meta fallback writes without awaiting them. A health read during that window sees the sentinel or stale metadata and can classify cable health as `EMPTY`, even while the request returns valid last-good cable data.

### Requirements

- R1. A transient NGA null with valid `fallbackCache` data must never expose the public cable-health key as `EMPTY`.
- R2. Health metadata and the cable-health response must describe the same usable fallback snapshot after the handler completes.
- R3. A legitimate computed result with zero cables remains valid positive data with `recordCount: 0`.
- R4. Preserve the inner `cable-health-nga-warnings-v2` negative cache and backoff behavior.
- R5. Do not change seeder schedules, health grace or thresholds, scoring, or production operations.

### Acceptance Examples

- AE1. Given a prior non-empty cable snapshot and a later NGA null, the handler returns the prior snapshot, leaves no public negative sentinel, and awaits public-key and seed-meta fallback writes before resolving.
- AE2. A health read after the fallback response resolves sees the same cable count as the served fallback and does not classify the public key as empty.
- AE3. Given a successful NGA computation with no active cable signals, the handler returns and positively caches `cables: {}` with metadata `recordCount: 0`.
- AE4. The inner NGA cache still writes its negative sentinel on a null upstream result.

### Scope Boundaries

- In scope: the cable-health server handler and focused regression coverage for cache publication ordering and zero-cable validity.
- Out of scope: the NGA fetcher, the inner NGA cache, relay warm-ping cadence, health classification rules, seeders, thresholds, grace periods, production Redis state, and production deployment.

## Planning Contract

### Key Technical Decisions

- KTD1. Use `cachedFetchJsonWithMeta` with `cacheFailures: false` for the computed `cable-health-v1` call. This disables only the outer negative sentinel while retaining positive caching for both non-empty and legitimate zero-cable responses.
- KTD2. Leave the nested NGA `cachedFetchJson` call unchanged. Its negative sentinel and unavailable backoff remain the upstream protection mechanism.
- KTD3. Await the existing public-key and seed-meta `setCachedJson` calls together before returning the fallback. This makes the health view and served snapshot one completed publication unit without adding a new abstraction.
- KTD4. Keep fallback selection and the honest `recordCount` calculation unchanged. An empty cable map is valid data, not a fake one-record response.

### Data Shape

The handler has one public response shape, `GetCableHealthResponse`, and one fallback publication pair. A successful or fallback response is usable data. Only the nested NGA warning fetch may use the negative sentinel path.

### Sequencing

1. Add proof-first coverage that observes the cache writes before the handler promise resolves and checks the former race window.
2. Switch only the outer computed cache to positive-only behavior and await the existing fallback publications.
3. Run focused handler and cache tests, then the required API, boundary, and diff checks.

### Risks and Dependencies

- Redis write failure remains best-effort because `setCachedJson` returns `false`; awaiting it only ensures the handler does not finish before the attempt completes. Production health can still be stale if Redis is unavailable, which remains an operational risk outside this change.
- The test must distinguish the outer computed key from the inner NGA key so it proves the requested boundary without weakening upstream backoff.

## Implementation Units

### U1. Prove and repair positive-only cable-health publication

- Goal: Prevent the public computed cache from storing a negative sentinel and close the fallback publication race.
- Requirements: R1-R5; AE1-AE4.
- Dependencies: None.
- Files: `server/worldmonitor/infrastructure/v1/get-cable-health.ts`, `tests/handlers.test.mts`, `tests/cable-health-cache-race.test.mts`.
- Approach: Add the smallest import-safe handler harness or focused source-level seam that controls Redis reads and writes. Start with a failing test that makes the inner NGA read return null, provides a valid last-good snapshot, delays the fallback writes, and reads the observed public and metadata state before and after handler resolution. Add coverage for a successful zero-cable result and the unchanged inner NGA negative-sentinel path. Then use the existing metadata-aware cache helper with outer failure caching disabled and await both fallback writes.
- Execution note: Use proof-first regression coverage. The test must fail because the old outer sentinel and unawaited writes are observable before implementation changes.
- Test scenarios:
  - Covers AE1. A valid last-good snapshot plus transient NGA null returns that snapshot and produces no outer `cable-health-v1` negative sentinel.
  - Covers AE2. A health-style read during the former write window cannot observe an empty public key after the handler promise resolves; the public payload and seed metadata carry the same cable count.
  - Covers AE3. A successful empty computed map is positively cached with `recordCount: 0`.
  - Covers AE4. The nested NGA cache still writes its negative sentinel and retains its short unavailable backoff behavior.
  - A failed fallback write does not reject the response or change the served fallback shape.
- Verification: The focused regression suite passes, including assertions that all required fallback writes settle before the handler resolves. Existing cable signal and health-map tests remain green.

## Verification Contract

- Red proof: The new cable-health race test fails on the current implementation for the expected outer-sentinel or unsettled-write reason.
- Focused green proof: `node_modules/.bin/tsx --test tests/cable-health-cache-race.test.mts tests/handlers.test.mts tests/redis-caching.test.mjs`.
- API gate: `npm run typecheck:api`.
- Architecture gate: `npm run lint:boundaries`.
- Diff hygiene: `git diff --check` and `git status --short`.
- PR gate: Refresh the exact existing PR head before push and after CI reaches a terminal state. Keep readiness, formal approval, deployment, production observation, and merge authority separate.

## Definition of Done

- U1 passes every listed scenario and verification gate.
- The outer public cable-health cache is positive-only, while the inner NGA negative cache is unchanged.
- A completed response and its health metadata describe one usable snapshot, including a legitimate zero-cable snapshot.
- No seeder, schedule, threshold, grace, or production-operation change is present.
- The diff contains no abandoned experiment or speculative abstraction.
