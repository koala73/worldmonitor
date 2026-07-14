# Bootstrap R2 timeout measurement

**Status:** instrumented, operational measurement blocked

This is the evidence record for issue #5300 U3a. It remains incomplete until the production
calibration and independent validation windows pass every gate below. The serving constants in
`api/_bootstrap-r2.js` remain `null`; Redis remains authoritative.

## Instrumented contract

- `BOOTSTRAP_R2_SHADOW_MEASURE=1` is honored only when `VERCEL_ENV=production`.
- Public `fast` and `slow` origin requests still assemble and return Redis data.
- The R2 read runs only in `ctx.waitUntil` with the independent 5,000 ms probe ceiling.
- Axiom receives one exact-allowlist `bootstrap_r2_shadow` event with the shared
  `r2 | fallback` outcome vocabulary.
- The first shadow probe in an isolate is tagged cold; later probes are tagged warm.
- The response temporarily exposes its Redis duration and cache classifier headers for client RUM.
- Each shadow Redis pipeline appends one ignored marker read:
  `bootstrap:r2-shadow-origin-marker:<tier>`. MONITOR counts these markers instead of inferring
  origin traffic from the canonical tier pipeline, which the publisher now executes too.
- Client RUM chooses one tier per page and queues only three numeric DebugBear custom metrics
  (total, Redis, derived non-R2 overhead) plus three closed tags (tier, success/abort, mobile/desktop).
  It rejects missing, cached, conflicting, malformed, or impossible timing samples.

## Required setup before collection

1. Restore Railway CLI write authentication and create `publish-bootstrap-tiers` in production.
2. Install only the scoped publisher credentials in Railway and verify two successive advancing
   objects for both tiers. Set `IRAN_EVENTS_ENABLED` explicitly to the same value in Railway and
   Vercel so the publisher and serving registry cannot resolve different tier shapes.
3. Merge and deploy the disabled instrumentation.
4. In DebugBear RUM settings, map the currently unused custom slots:
   `metric1=bootstrap total`, `metric2=bootstrap Redis`, `metric3=bootstrap non-R2 overhead`,
   `tag1=bootstrap tier`, `tag2=bootstrap outcome`, and `tag3=device class`. Use a project with
   session tracking disabled (or disable it for this window) and record that setting below; the
   existing project currently reports sessions enabled, which would violate U3a's no-stable-ID
   evidence contract even though the six custom fields themselves contain no identifier.
5. Confirm `USAGE_TELEMETRY=1`, `AXIOM_API_TOKEN`, the scoped R2 read credentials, and the shared
   bucket routing values are present in Vercel production. Do not install them in preview.
6. Purge the two public bootstrap CDN objects, capture the first MISS and following HIT, and record
   the observed `Age`, `X-Vercel-Cache`, and `CF-Cache-Status` tuple below. The current classifier
   is a conservative candidate; no RUM sample is evidence until this production check passes.
7. Enable `BOOTSTRAP_R2_SHADOW_MEASURE=1` in Vercel production.

DebugBear documents five programmatic numeric metric slots and five string tag slots through its
snippet API. The public WorldMonitor snippet inspected on 2026-07-14 reported no configured custom
mappings. Adding the six bootstrap values does not add a request, user, or device ID to the
page-level custom fields. That is not sufficient by itself: the collector's project-level session
setting applies to the resulting page view. Record proof that sessions are disabled before treating
any sample as U3a evidence; otherwise use a dedicated privacy-minimal project or collector.

DebugBear session tracking disabled for the measurement window: **pending — blocked**.

## Controlled cache-classifier proof

| Check | Observed UTC | Age | X-Vercel-Cache | CF-Cache-Status | Result |
|---|---|---:|---|---|---|
| Purged origin MISS | pending | pending | pending | pending | blocked |
| Following cache HIT | pending | pending | pending | pending | blocked |

## Calibration

Minimum 2,000 observations per `(tier, execution region)`, spanning cold/warm execution and a full
daily traffic cycle.

| Tier | Region | Start/end UTC | n | Cold n | Warm n | Candidate T (ms) | C_happy (ms) |
|---|---|---|---:|---:|---:|---:|---:|
| fast | pending | pending | 0 | 0 | 0 | pending | pending |
| slow | pending | pending | 0 | 0 | 0 | pending | pending |

## Independent validation

Freeze each candidate before this subsequent full-day window. Record the one-sided 95% binomial
upper confidence bound for `P(L > T)`; every cohort must be at most 0.2%.

| Tier | Region | Start/end UTC | n | Exceedances | 95% upper bound | Pass |
|---|---|---|---:|---:|---:|---|
| fast | pending | pending | 0 | 0 | pending | blocked |
| slow | pending | pending | 0 | 0 | pending | blocked |

Formula/tool: pending.

## Denominator certification

Run Redis MONITOR over the exact Axiom window. Count the unique per-tier marker GETs and compare
them with `bootstrap_r2_shadow` events. Each tier must differ by no more than 1%, and every region
observed in production Vercel function logs must appear in Axiom.

| Tier | Start/end UTC | MONITOR markers | Axiom events | Difference | Pass |
|---|---|---:|---:|---:|---|
| fast | pending | 0 | 0 | pending | blocked |
| slow | pending | 0 | 0 | pending | blocked |

## Resulting serving constants

| Constant | Value | Status |
|---|---:|---|
| `BOOTSTRAP_R2_TIMEOUT_MS_FAST` | `null` | blocked pending evidence |
| `BOOTSTRAP_R2_TIMEOUT_MS_SLOW` | `null` | blocked pending evidence |

Do not implement U4 while either value is `null` or any cohort, cache-classifier, or denominator
gate is incomplete.

## Disablement proof before U4

- `BOOTSTRAP_R2_SHADOW_MEASURE` disabled: pending.
- Both CDN objects purged after disablement: pending.
- Production responses contain no `Server-Timing: wm_bootstrap_redis`: pending.
- Temporary RUM no longer queues new samples: pending.
