---
title: "Stale Content Grace - Plan"
type: fix
date: 2026-09-03
---

# Stale Content Grace - Plan

## Goal Capsule

- Objective: Add a finite three-hour gray period after content first becomes stale. Keep `STALE_CONTENT` diagnostics visible during the period, but do not let those entries make the top-level health verdict non-healthy until the period expires.
- Authority: The current request and root `AGENTS.md` define behavior and delivery. Existing health contracts define status precedence, Redis access, and snapshot caching.
- Stop condition: The proof-first tests cover a timestamp just beyond its budget, missing `newestItemAt`, and the exact expiry boundary. Focused and wider API gates pass. One ready pull request contains the plan, tests, and implementation.
- Execution profile: Code change in the Vercel Edge health path. No seeder or browser change.
- Tail ownership: Deployment and production observation remain outside this pull request. The final handoff must state that risk.

## Product Contract

### Summary

`/api/health` continues to report `STALE_CONTENT` as soon as a content-age contract fails. For the first three hours after the freshness boundary, the entry remains in the detailed and compact problem output with its deadline, but it counts in the healthy summary bucket. At and after the deadline, it counts as a warning under the existing status rules.

### Problem Frame

The production compact endpoint currently changes to `WARNING` at the exact content-age boundary even when the producer is current. The reproduced response showed two cases:

- `diseaseOutbreaks` had a recent seeder run and content about 170 minutes beyond its nine-day content budget.
- `temporalAnomalies` had a recent seeder run and `contentAgeMin: null`, which means the opted-in producer supplied no usable `newestItemAt`.

Both entries were correctly diagnosed as `STALE_CONTENT`, but both immediately increased `summary.warn` and changed the top-level status. Sparse publishers and short timestamp gaps need one explicit, bounded observation period without losing the diagnostic.

### Requirements

#### Health verdict behavior

- R1. Use a three-hour stale-content grace period. The repository has rollout-specific windows, but no duration that directly applies to routine content-age boundary jitter.
- R2. Keep the public status `STALE_CONTENT` during grace. Do not add a new status.
- R3. Publish `staleContentGraceUntil` on a graced entry so the diagnostic and exact deadline remain visible in full and compact health responses.
- R4. During grace, count the entry in `summary.ok`, keep it in `summary.staleContent`, exclude it from `summary.warn`, and do not let it change the top-level verdict.
- R5. At `now >= staleContentGraceUntil`, remove the grace field and count `STALE_CONTENT` through its existing warning bucket.
- R6. Future-dated content remains an immediate `STALE_CONTENT` warning. The grace covers age crossing a past freshness boundary, not invalid future observations.

#### Stable missing-timestamp deadline

- R7. When `newestItemAt` or a per-entity `criticalOldestObservedAt` proves that its configured freshness boundary has passed, derive the grace deadline from that boundary plus three hours without persistent state.
- R8. When a usable stale assessment has no boundary timestamp, or per-entity stale counts trip before the timestamp boundary, claim one first-observation deadline in Redis with `HSETNX`, then read that stored deadline. A fresh seeder `fetchedAt` must not move it.
- R9. Clear a source's stored first-observation deadline only after both source-level and per-entity content-age contracts become fresh again. A later distinct undatable incident can then receive a new finite grace.
- R10. If the optional grace-state read or write fails or returns invalid data, fail closed. Keep the normal `STALE_CONTENT` warning instead of extending or inventing grace.

#### Cache correctness and proof

- R11. A cached full or compact verdict must not survive past `staleContentGraceUntil`. Reuse the existing deadline-aware read guard and snapshot TTL calculation.
- R12. Add proof-first tests for source-level and per-entity just-over-budget timestamps, the null timestamp that keeps its original deadline across fresh seeder metadata, and the exact expiry boundary.

### Acceptance Examples

- AE1. At 09:01, content with a 09:00 freshness boundary is `STALE_CONTENT`. Its `staleContentGraceUntil` is 12:00. The entry is present in compact `problems`, `summary.staleContent` includes it, `summary.warn` does not, and the top-level status can remain `HEALTHY`.
- AE2. A null `newestItemAt` first observed at 09:00 claims a 12:00 deadline. Seeder metadata written again at 10:00 reads the same stored 12:00 deadline and does not restart the window.
- AE3. At exactly 12:00, the entry has no active grace and counts as the existing `STALE_CONTENT` warning.
- AE4. A future-dated `newestItemAt` has no grace and counts as a warning immediately.
- AE5. A PortWatch critical-country observation just beyond its pinned budget has the same three-hour diagnostic grace as a source-level content-age failure.

### Success Criteria

- The live failure shapes are represented by deterministic tests at the actual `api/health.js` classifier and response helpers.
- Existing status vocabulary and precedence remain unchanged.
- The health snapshot cache becomes strict at the same instant as the stale-content grace deadline.
- The pull request is green and ready. It is not merged, auto-merged, or sent for review.

### Scope Boundaries

- In scope: `api/health.js`, focused health tests, the health endpoint documentation and validator, the scheduled seed-freshness monitor, and this plan.
- Out of scope: changing source freshness budgets, changing seeder schedules, changing producer timestamp extraction, adding a health status, deploying the pull request, or changing unrelated rollout-grace policies.

## Planning Contract

### Key Technical Decisions

- KTD1. Keep classification and severity separate. `classifyKey` continues to return `STALE_CONTENT`. A small summary-bucket helper treats only a `STALE_CONTENT` entry with an active `staleContentGraceUntil` as healthy for counting. This preserves diagnostics and all status consumers.
- KTD2. Use the observation clock when it proves the failed boundary. A valid past source-level or per-entity observation has a deterministic deadline and needs no Redis state.
- KTD3. Persist only the clock that cannot be derived. A versioned Redis hash stores one deadline per source for null timestamps and count-driven per-entity failures that occur before the timestamp boundary. This is the smallest durable state that prevents every fresh seeder write from restarting grace.
- KTD4. Namespace the grace-state hash with the existing `healthVerdictRedisKey` helper. Production keeps a stable key. Preview deployments remain commit-scoped.
- KTD5. Keep cached verdicts deadline-safe. Add `staleContentGraceUntil` to the existing expiry guard and nearest-deadline scan instead of adding a second cache mechanism.

### Assumptions

- `summary.staleContent` remains a diagnostic count of all entries with status `STALE_CONTENT`, including entries inside grace. It is not used as the top-level warning count.
- Compact output must retain a graced entry because its status remains a problem status. No separate summary deadline map is needed.
- Redis state can be cleared after a fresh content-age assessment. If the clear fails, the next null incident can receive a shorter or expired grace, which fails closed and does not hide a warning.
- One extra small Redis pipeline after seed metadata parsing is acceptable. It contains two hash commands per null content-age source and at most one bulk cleanup command for recovered sources.

### Implementation Constraints

- Use the existing `redisPipeline` transport and command-result conventions.
- Do not import browser code or server-only modules into `api/health.js`.
- Do not weaken earlier classifier branches. `STALE_SEED`, source faults, coverage failures, and missing data keep their current precedence.
- Do not use `fetchedAt` as the null-content grace clock.
- Do not add producer-specific exceptions for disease outbreaks or temporal anomalies.

### Sequencing

1. Add and run the focused tests against current code. Commit the red reproduction before implementation.
2. Add the shared grace calculation, stable null-deadline commands, summary counting, and cache-deadline handling.
3. Run focused tests, API type checks, import-boundary checks, and final diff checks.

## Implementation Units

### U1. Lock the stale-content grace contract with failing tests

- Goal: Prove the three required failure shapes against the current health behavior before code changes.
- Requirements: R1-R12, with direct assertions for AE1-AE4.
- Files: `tests/health-content-age.test.mjs`, `tests/health-content-freshness.test.mjs`, `tests/health-verdict-snapshot.test.mjs`.
- Approach: Extend the current classifier tests with deterministic clocks. Assert deadline derivation, null-deadline persistence semantics, summary bucket selection, compact problem visibility, and strict boundary handling. Extend snapshot tests so the cache TTL and read guard honor `staleContentGraceUntil` in full and compact shapes.
- Test scenarios:
  - Content one minute beyond its budget gets a deadline at boundary plus three hours and counts as healthy during grace.
  - Per-entity critical content one minute beyond its budget gets the same deadline contract.
  - Null content gets the stored first deadline even when a later request proposes a later candidate.
  - The exact deadline counts as warning and invalid state fails closed.
  - Future-dated content is not graced.
- Verification: Run `node --test tests/health-content-age.test.mjs tests/health-verdict-snapshot.test.mjs` and capture the expected failures on the current implementation.
- Dependencies: None.

### U2. Implement the finite health gray period

- Goal: Make the tests pass through the production `api/health.js` evaluation and snapshot path.
- Requirements: R1-R12.
- Files: `api/health.js`.
- Approach:
  - Add a three-hour constant and a versioned, deployment-scoped Redis hash key.
  - Derive timestamp-based deadlines from the content freshness boundary.
  - Normalize source-level and per-entity stale evidence before selecting a derived or first-observation deadline.
  - Build `HSETNX` and `HGET` commands for null timestamps, parse only finite stored deadlines, and issue one `HDEL` for recovered sources.
  - Pass resolved null deadlines into `classifyKey` and publish `staleContentGraceUntil` only while status is `STALE_CONTENT` and the deadline is in the future.
  - Count active-grace `STALE_CONTENT` entries in `ok` while retaining the `staleContent` diagnostic subcount and compact problem entry.
  - Include the new deadline in cached-snapshot expiry and TTL scans.
- Test scenarios:
  - All U1 scenarios turn green without changing the `STALE_CONTENT` status.
  - Existing content-age precedence and future-timestamp tests remain green.
  - Existing rollout and content-freshness deadline tests remain green.
- Verification: Run the focused commands in the Verification Contract.
- Dependencies: U1.

### U3. Keep the documented summary contract accurate

- Goal: Document that `summary.staleContent` remains diagnostic and can exceed `summary.warn` while one or more entries are inside grace.
- Requirements: R3-R5.
- Files: `docs/health-endpoints.mdx`, `docs/zh/health-endpoints.mdx`, `scripts/docs-stats.mjs`, `tests/docs-stats-health-total.test.mts`.
- Approach: Update both language variants. Narrow the existing subset validator so it continues to enforce `rolloutPending <= warn` but permits graced stale-content diagnostics outside the warning bucket.
- Test scenarios:
  - A valid partition with `staleContent > warn` passes.
  - `rolloutPending > warn` still fails.
- Verification: Run `node_modules/.bin/tsx --test tests/docs-stats-health-total.test.mts`.
- Dependencies: U2.

### U4. Keep the scheduled production monitor aligned

- Goal: Prevent the scheduled seed-freshness monitor from treating an active, bounded stale-content grace entry as blocking.
- Requirements: R3-R5 and R10-R12.
- Files: `scripts/check-seed-freshness.mjs`, `tests/seed-freshness-monitor.test.mjs`.
- Approach: Reuse the monitor's deadline-validation pattern. Soften only `STALE_CONTENT` entries with a parseable future `staleContentGraceUntil` no more than three hours away. Missing, malformed, excessive, or expired deadlines remain blocking.
- Test scenarios:
  - An active bounded deadline is diagnostic but not operationally blocking.
  - The exact deadline is blocking.
  - Missing, malformed, excessive, and wrong-status deadlines remain blocking.
- Verification: Run `node_modules/.bin/tsx --test tests/seed-freshness-monitor.test.mjs`.
- Dependencies: U2.

## Verification Contract

- Red proof: `node --test tests/health-content-age.test.mjs tests/health-verdict-snapshot.test.mjs` must fail on the new grace assertions before U2.
- Focused green proof: `node --test tests/health-content-age.test.mjs tests/health-verdict-snapshot.test.mjs tests/health-verdict-compact-snapshot.test.mjs`.
- Documentation contract: `node_modules/.bin/tsx --test tests/docs-stats-health-total.test.mts`.
- Monitor contract: `node_modules/.bin/tsx --test tests/seed-freshness-monitor.test.mjs`.
- API gate: `npm run typecheck:api`.
- Architecture gate: `npm run lint:boundaries`.
- Diff hygiene: `git diff --check` and `git status --short`.
- Pull request gate: Refresh the exact final head with `npm run --silent agent:pr-snapshot -- --pr <number> --refresh --phase final`, then report checks, mergeability, approval, and deployment as separate states.

## Risks and Dependencies

- The null-timestamp case depends on Redis to remember the first deadline. A failed grace-state operation deliberately produces an immediate warning, not an unbounded healthy state.
- A timestamp-based source that is already more than three hours beyond its budget when this code deploys receives no retroactive grace. This keeps the window tied to the real content boundary.
- A cleanup failure can make a later null incident strict earlier than intended. It cannot extend the grace or hide stale content.
- No production behavior changes until Vercel deploys a merged commit. This pull request can prove code readiness only.

## Definition of Done

- U1 has a committed red reproduction from current behavior.
- U2 makes every focused assertion pass with the existing public status vocabulary.
- The wider API and boundary gates pass.
- The diff contains only necessary plan, test, and health-path changes. No abandoned implementation remains.
- One ready pull request targets `main`. It is not merged, auto-merged, or sent to reviewers.
