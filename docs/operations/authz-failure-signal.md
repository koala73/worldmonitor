---
title: "Authorization-failure signal (Axiom alert)"
description: "Alert-only observability for high distinct-route authz failures per identity. Decision for #8406; no request-path throttle or lockout."
---

# Authorization-failure signal

Issue [#8406](https://github.com/koala73/worldmonitor/issues/8406) records that
volumetric rate limiting and entitlement enforcement work as designed, but
nothing watches **authorization failures per identity**. A methodical scanner
stays under the global request ceiling by construction, so request-rate limiting
is the wrong instrument for that pattern.

## Decision (2026-09-20)

| Option | Verdict | Why |
| --- | --- | --- |
| **1. Alert only** (Axiom query / monitor over `wm_api_usage`) | **Chosen** | No request-path cost; no false-positive risk to users; matches product size. |
| 2. Soft throttle on authz failures | Deferred | Adds Redis on the failure path; revisit only if alerts show sustained scanner traffic that ops cannot triage. |
| 3. Account lockout | Rejected | Free users hit `tier_403` by clicking premium features — that is the paywall working. Auto-lockout would be hostile. |

Explicit non-goals (do not "fix" #8406 with these):

- Lowering `GLOBAL_RATE_LIMIT` in `server/_shared/rate-limit.ts`
- Changing entitlement enforcement
- Blocking or banning accounts automatically

## What the signal measures

A high count of authorization failures from **one identity across many distinct
routes** in a short window is qualitatively different from request volume.

| Field | Source | Notes |
| --- | --- | --- |
| Dataset | `wm_api_usage` | See [usage telemetry](../architecture/usage-telemetry.md) |
| Event filter | `event_type == "request"` and `reason in ("tier_403", "auth_401")` | Entitlement deny + unauthenticated reject. Do not fold in `auth_403` / origin blocks unless the monitor is deliberately widened later. |
| Identity | `principal_id` | Clerk user id or hashed API/widget key. **Anon emits `principal_id: null`** (`server/_shared/usage-identity.ts`) — the primary monitor therefore covers authenticated principals only. |
| Diversity metric | `dcount(route)` | Route fan-out, not request count. A free user retrying one premium panel is low diversity; a scanner walking many paths is high. |

Pen-test reference (authorized Strix run, 2026-09-19): one free principal produced
**12 × `tier_403` across 10 distinct premium routes within ~15 seconds**. Peak
traffic stayed ~4% of the global volumetric limit. That shape is the alert
target, not a volume spike.

## Baseline (measured)

Queried production `wm_api_usage` on **2026-09-20** for
`_time` in **2026-09-13 → 2026-09-20** (7d). Filter:
`event_type == "request"`, `reason in ("tier_403","auth_401")`,
`isnotnull(principal_id)`.

### Hourly distinct-route distribution

| Slice | Principal-hours | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| All authenticated | 1,908 | 1 | 11 | 25 | 73 |
| `clerk_jwt` only | 1,518 | 1 | 1 | 2 | 10 |
| `user_api_key` only | 375 | 11 | 26 | 46 | 73 |
| All except top outlier key | 1,873 | 1 | 11 | 11 | 12 |

### What that means

- **Session JWT traffic is quiet.** Almost every free signed-in user who hits a
  paywall touches one or two premium API paths per hour. A burst across ten
  paths (the pen-test) is already above the observed JWT max for the week.
- **Free-tier API keys are a different population.** Two keys account for every
  hour with ≥12 distinct authz-failure paths in the window
  (`user_3FJla…` with 27 hot hours / peak `dcount(route)=73`; `user_3F99…`
  with 8 hot hours / peak 12). Treating them with the JWT threshold would page
  constantly.
- **Do not use a single N for all `auth_kind`s.** Split thresholds below.

Re-run the baseline queries in this doc before changing N, and after any week
that included a known pen-test or load exercise.

## Calibrated thresholds (v1)

| Field | `clerk_jwt` / `mcp_oauth` | `user_api_key` / `enterprise_api_key` / `widget_key` |
| --- | --- | --- |
| Window | 1h rolling | 1h rolling |
| Metric | Distinct `route` with `tier_403` or `auth_401` | Same |
| Threshold N | **8** | **40** |
| Expected false-positive rate (from 7d sample) | ~1 hour / week (JWT max was 10; ≥8 fired once) | Pages only the extreme hours of the known heavy free API-key probe (≥30 was 12 hours / 7d for that population) |
| Catches pen-test shape? | Yes (ten distinct paths / 15s) | N/A (that run used a free session principal) |
| Monitor enabled | **Yes — create after merge** | Same query, split by `auth_kind` |
| Owner | `@koala73` | Reassign if security/ops ownership moves |
| Channel | Axiom monitor → existing ops notification path | Link this runbook in the monitor description |

Why not the first draft of "8 for everyone": without splitting, ≥8 matched
**197 / 1,908** principal-hours (~10%) in the sample — mostly free API-key
fan-out. That would be an alarm nobody trusts.

## Detection query (copy into Axiom)

```kusto
['wm_api_usage']
| where event_type == "request"
  and reason in ("tier_403", "auth_401")
  and isnotnull(principal_id)
  and _time > ago(1h)
| summarize distinct_routes = dcount(route),
            failures = count(),
            reasons = make_set(reason),
            tiers = make_set(tier),
            sample_routes = make_set(route, 20),
            customer_ids = make_set(customer_id)
            by principal_id, auth_kind
| where (auth_kind in ("clerk_jwt", "mcp_oauth") and distinct_routes >= 8)
     or (auth_kind in ("user_api_key", "enterprise_api_key", "widget_key") and distinct_routes >= 40)
| order by distinct_routes desc
```

Group by `principal_id` + `auth_kind` only. For `clerk_jwt`, `customer_id` is
the active org when present else the user (`server/_shared/usage-identity.ts`),
so including it in the group key can split one principal across rows and
suppress the alert.

### Baseline re-measure (before changing N)

```kusto
['wm_api_usage']
| where event_type == "request"
  and reason in ("tier_403", "auth_401")
  and isnotnull(principal_id)
  and _time > ago(7d)
| summarize distinct_routes = dcount(route),
            failures = count()
            by principal_id, auth_kind, bin(_time, 1h)
| summarize hours = count(),
            p50 = percentile(distinct_routes, 50),
            p95 = percentile(distinct_routes, 95),
            p99 = percentile(distinct_routes, 99),
            max_routes = max(distinct_routes)
            by auth_kind
```

### Top principals (sanity check)

```kusto
['wm_api_usage']
| where event_type == "request"
  and reason in ("tier_403", "auth_401")
  and isnotnull(principal_id)
  and _time > ago(7d)
| summarize distinct_routes = dcount(route),
            failures = count(),
            sample_routes = make_set(route, 15),
            customer_ids = make_set(customer_id)
            by principal_id, auth_kind, tier
| order by distinct_routes desc
| take 30
```

### Optional secondary: anon fan-out by IP

Anon rows have `principal_id == null`. If ops wants a complementary view of
unauthenticated route enumeration, group by Cloudflare-verified `ip` (same
caveats as other IP telemetry — see usage-telemetry field notes). Keep this
**off** the paging path until its own baseline exists; shared NAT and scrapers
make IP noisier than `principal_id`.

```kusto
['wm_api_usage']
| where event_type == "request"
  and reason in ("tier_403", "auth_401")
  and auth_kind == "anon"
  and isnotnull(ip)
  and _time > ago(1h)
| summarize distinct_routes = dcount(route),
            failures = count(),
            sample_routes = make_set(route, 20)
            by ip, country
| where distinct_routes >= 20
| order by distinct_routes desc
```

## Runbook — when it fires

1. **Confirm shape.** Open the monitor series and the detection query for the
   firing hour. Note `principal_id`, `customer_ids`, `auth_kind`, `tier`,
   `distinct_routes`, and `sample_routes`.
2. **Check for known exercise.** Authorized pen-tests, partner demos, and
   load tests produce this signature on purpose. Confirm with the owner before
   treating it as hostile.
3. **Distinguish paywall browsing from enumeration.**
   - JWT, a few related premium routes, `tier_403` only → likely a free user
     hitting Pro features (or a false positive near N=8 — raise N if recurrent).
   - Many unrelated routes, mixed `auth_401`/`tier_403`, or case/alias
     duplicates of the same form path → scanner-like.
   - Free `user_api_key` near N=40 → check whether the key is a known
     integration probing premium surfaces vs. a new enumerator.
4. **Do not auto-ban.** Document the principal and window. If abuse continues,
   prefer manual account review, key rotation, or (later) a scoped soft
   throttle — never a silent lockout from this alert alone.
5. **Do not lower the global rate limit.** Volume was not the miss; diversity
   was. Lowering `GLOBAL_RATE_LIMIT` punishes legitimate users and still misses
   a slow scanner.
6. **Close the loop.** If the fire was a false positive from legitimate
   diversity, raise that `auth_kind`'s N and record the new percentile evidence
   in the threshold table. If it was a true scanner and alert-only is
   insufficient, open a follow-up for option 2 (failure-scoped soft throttle)
   with measured rates.

## Enable checklist

1. Paste the detection query into Axiom as a saved query named
   `authz-failure-fanout-per-principal`.
2. Create a monitor on that query (notify `@koala73` / the security ops channel).
3. Paste this runbook URL into the monitor description.
4. Confirm a synthetic check: temporarily lower JWT N to 2 in a **non-paging**
   draft, verify rows appear, then restore N=8 before enabling pages.

## Related

- [Usage telemetry](../architecture/usage-telemetry.md) — field dictionary and other APL recipes
- `server/_shared/usage-identity.ts` — `principal_id` is null for anon
- `server/_shared/rate-limit.ts` — volumetric limits (out of scope for this signal)
- Issue [#8406](https://github.com/koala73/worldmonitor/issues/8406)
