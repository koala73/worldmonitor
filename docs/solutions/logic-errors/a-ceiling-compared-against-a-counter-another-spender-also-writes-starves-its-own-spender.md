---
module: aviation
date: 2026-11-28
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - "get-flight-status and list-airport-flights return 200 with no flights and source \"budget\" about three days into each AviationStack billing cycle"
  - "Aircraft tracking keeps working, and the plan still has most of its monthly calls left"
root_cause: logic_error
resolution_type: code_fix
related_components: [background_job]
tags: [aviationstack, budget, quota, counter, seeder, redis, seed-aviation]
---

# A ceiling compared against a counter another spender also writes starves its own spender

## Problem

The AviationStack plan budget is a Redis counter per billing cycle, `aviation:avstack:calls:<cycle>`. The hourly seeder (`scripts/seed-aviation.mjs`) and the request-time RPCs both increment it. The request-time ceiling (`AVIATIONSTACK_REQUEST_BUDGET`) was checked against that shared total. The seeder spends about 1,350 calls a day, so the total passed the 7,000 request ceiling within days. From then on, every request-time lookup was refused until the cycle rolled over. On 2026-11-27 the counter read 7,112 at 2.87 days into the cycle. About 3.9k of that was seeder spend. An API Starter customer reported empty results.

## Solution

Fixed in #11470:

- **Separate counter.** `reserveAviationStackCalls` in `server/worldmonitor/aviation/v1/_avstack-budget.ts` now increments a request-only counter, `aviation:avstack:request-calls:<cycle>`, alongside the shared one. The request ceiling is compared against the request-only counter. The plan-wide cap still applies to the shared total.
- **Breach before fail-open.** A counter that answered over its ceiling blocks the call, even when the other counter returned an error. Fail-open applies only when no total over its ceiling is known.
- **Departure boards.** The seeder stores each hub's trimmed `dep_iata` page at `aviation:avstack:departures:v1:<IATA>`. `list-airport-flights` serves the departure leg from a board up to 90 minutes old, with no paid call.
- **Arrival cache.** Bought arrival pages cache for an hour.

The seeder's query also dropped `flight_date`. A query without `flight_date` returns the hub's local day. A UTC `flight_date` asks for a different day at hubs whose local date differs from UTC. At HND, the two queries shared 0 of 100 rows.

Verified in production on 2026-11-28. All 56 hubs had boards written at 03:30:59 UTC with 100 rows each. Twelve hub departure requests moved the request counter by 1, which was background traffic, not those requests.

## Why this works

A ceiling only protects one spender when it is measured against that spender's own spend. Against a shared total, the other spender's usage quietly eats the reserved share.

## Prevention

- Give each spender with its own ceiling its own counter. Keep the shared counter for the plan-wide cap only.
- Test it by reserving seeder spend above the request ceiling, then asserting that a request call is still allowed. See `tests/aviation-budget-cap.test.mjs`, "does not count seeder spend against the request ceiling".
- When a budget reservation touches several counters, test a partial Redis failure where one counter is already over its ceiling.
