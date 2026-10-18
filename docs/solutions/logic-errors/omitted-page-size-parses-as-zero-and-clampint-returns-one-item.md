---
module: server-rpc-list-handlers
date: 2026-10-01
problem_type: logic_error
component: service_object
severity: medium
symptoms:
  - "A list RPC returns exactly 1 item when the caller omits page_size (list-prediction-markets, list-arxiv-papers)"
  - "The same RPC returns a full page when page_size is sent explicitly"
  - "Seeded research feeds (Hacker News, trending repos) return an empty list for most of every hour"
  - "A seeded dataset reports unavailable forever while its seeder exits 0"
root_cause: logic_error
resolution_type: code_fix
related_components: [background_job, testing_framework]
tags: [page-size, clampint, resolvepagesize, sebuf, default-value, seeder-ttl, empty-array-fallback, graceful-fail, silent-empty]
---

# An omitted page_size parses as 0, and clampInt turns 0 into one item

## Problem

Four public list RPCs returned exactly one item by default from about March 2026 until #8754: `prediction/list-prediction-markets`, `research/list-arxiv-papers`, `research/list-trending-repos` and `research/list-hackernews-items`. A sweep of every open GET route with an anonymous session found them, plus three seeder defects that left datasets empty without any crash or health alert.

## Symptoms

- `GET /api/prediction/v1/list-prediction-markets` with no params returned `markets[1]`; `?page_size=50` returned 50.
- `list-arxiv-papers` returned one paper from December 2020 for any category.
- `list-hackernews-items` and `list-trending-repos` returned `[]` with and without params.
- `get-us-interest-rates` returned `{"series":[],"unavailable":true}` while its seeder exited 0 every run.

## What Didn't Work

- Calling each empty route with no params could not separate "needs a parameter" from a defect. Retrying with the params the dashboard sends showed that `get-bls-series` was working as designed (it serves only `USPRIV` and `ECIALLCIV` through `series_id`), while the others were real bugs.
- The handler tests passed an explicit `pageSize` in every case (5, 1, 100), so the default path was never exercised.

## Solution

**Page size.** The sebuf-generated route turns a missing query param into 0 (`src/generated/server/worldmonitor/prediction/v1/service_server.ts:98`):

```ts
pageSize: Number(params.get("page_size") ?? "0"),
```

`clampInt` only falls back for non-finite input (`server/_shared/constants.ts:3-6`), so 0 is clamped to the minimum:

```ts
clampInt(req.pageSize, 50, 1, 100)   // 0 → 1
```

The repo already had the right helper, added to the supply-chain module in #7401 with a comment describing this exact trap. #8754 moved `resolvePageSize` to `server/_shared/constants.ts`, next to `clampInt`, and used it in the four handlers:

```ts
const limit = resolvePageSize(req.pageSize, 50, 100); // 0 or absent → 50
```

No unguarded `clampInt(req.pageSize, …)` call remains in `server/`. The two left (`list-cyber-threats`, `list-climate-disasters`) handle 0 before clamping.

**Seeder landmines found in the same sweep:**

| Feed | Cause | Fix in #8754 |
|---|---|---|
| Hacker News | `HN_TTL = 600` against an hourly cron: keys existed ~10 minutes per hour | TTL 10800 (3× the cron, like `ARXIV_TTL`) |
| Trending repos | OSSInsight returns 200 with `rows: []`; `[]` is truthy, so `if (!repos)` never reached the GitHub-search fallback | `if (!repos?.length)`; TTL 10800 |
| arXiv | Export query had no `sortBy=submittedDate&sortOrder=descending`, so arXiv returned its default (oldest-relevant) order | Sort newest first |
| US interest rates | Seeder required SOFR history to start `2018-04-02`; FRED's first point is `2018-04-03`, so validation failed every run as a graceful exit 0 | Expect `2018-04-03` |

Production after the deploy: prediction markets 1 → 50, arXiv 1 (2020) → 50 (newest September 2026), Hacker News 0 → 30, trending 0 → 50. US interest rates seeded on the 2026-10-01 `seed-bundle-macro` run: 12 series with dated history, SOFR from 2018-04-03 (2,121 points), `unavailable: false`.

## Why This Works

Proto3 has no "absent" for scalars, and the generated routes encode absence as 0. Any clamp that treats 0 as a real request turns the documented "zero uses the server default" into "one item". `resolvePageSize` treats every value ≤ 0 as unset, which matches the proto contract.

The seeder bugs share a shape: each failure was graceful, so no crash, Railway alert or health status went red. A TTL shorter than the cron, a truthy empty array and an off-by-one start date all produce an empty or stale key while the process reports success.

## Prevention

- Use `resolvePageSize` for any sebuf `page_size`; never `clampInt(req.pageSize, …)` without a `<= 0` guard.
- Give every list handler one test with `pageSize: 0` that expects the documented default count.
- Set a seeder's key TTL to at least 3× its cron interval.
- Treat an empty upstream list as missing when choosing a fallback (`!rows?.length`, not `!rows`).
- Pin literal upstream facts in tests (for example SOFR's first date `'2018-04-03'`), not values rebuilt from the code under test.
- To find silent empties: call every open GET route with an anonymous `wms_` session from `POST /api/wm-session`, flag empty or single-item responses, then retry the flagged ones with realistic params before calling them defects.

## Related

- #8754 (the fixes) and #8080 (the widget data catalog whose production sweep surfaced them).
- [Widget agent data fetches 401'd and were silently routed to web search](../integration-issues/widget-agent-data-fetches-401-silently-routed-to-web-search.md), another silent failure the model routed around.
