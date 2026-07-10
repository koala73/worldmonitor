---
status: pending
priority: p1
issue_id: "049"
tags: [code-review, security, health, seeding, pr-2375]
dependencies: []
---

## Problem Statement

`api/health.js` classifies three seeded Redis keys (`shippingStress`, `diseaseOutbreaks`, `socialVelocity`) under `STANDALONE_KEYS` instead of `BOOTSTRAP_KEYS`. These keys are written by seed loops in `ais-relay.cjs` and `scripts/seed-disease-outbreaks.mjs`, so the health monitor should alert CRITICAL when they are empty — not just WARN. Using `STANDALONE_KEYS` masks genuine seed failures as non-critical, silently degrading these panels for all users.

## Findings

- **File:** `api/health.js:115-117` — `shippingStress`, `diseaseOutbreaks`, `socialVelocity` listed in `STANDALONE_KEYS`
- **Contrast:** Other relay-seeded keys (`marketQuotes`, `commodities`, `gpsjam`, etc.) correctly sit in `BOOTSTRAP_KEYS`
- **Seed sources:**
  - `diseaseOutbreaks` → `scripts/seed-disease-outbreaks.mjs` (Railway cron)
  - `shippingStress` → `scripts/ais-relay.cjs` `seedShippingStress` loop (15min)
  - `socialVelocity` → `scripts/ais-relay.cjs` `seedSocialVelocity` loop (10min)
- **Impact:** If any seed loop dies, health.js reports WARN (not CRIT), on-call is not paged, panels silently show stale/empty data

## Proposed Solutions

**Option A: Move keys to BOOTSTRAP_KEYS (Recommended)**

In `api/health.js`, remove `shippingStress`, `diseaseOutbreaks`, `socialVelocity` from `STANDALONE_KEYS` and add them to `BOOTSTRAP_KEYS` alongside their `SEED_META` entries.

- **Effort:** Small (3-line move)
- **Risk:** Very low — only affects health alerting severity

**Option B: Add SEED_META entries without moving to BOOTSTRAP_KEYS**

Keep in STANDALONE_KEYS but add staleness checks. This is a non-fix; STANDALONE_KEYS is semantically wrong for seeded data.

- **Effort:** Small
- **Risk:** Does not resolve the core misclassification

## Acceptance Criteria

- [ ] `shippingStress`, `diseaseOutbreaks`, `socialVelocity` removed from `STANDALONE_KEYS`
- [ ] All three added to `BOOTSTRAP_KEYS`
- [ ] Health endpoint returns CRITICAL (not WARN) when any of these keys are empty
- [ ] SEED_META entries present for all three (check current state in health.js)

## Work Log

- 2026-03-27: Identified by code-review agents during PR #2375 review.
