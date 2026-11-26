---
title: A canary retry inside the server's negative cache never reaches the upstream
date: 2026-11-25
category: logic-errors
module: MCP tool canary
problem_type: logic_error
component: testing_framework
symptoms:
  - "MCP tool canary filed an issue for analyze_situation (-32003 Required data inputs are unavailable) after a single transient provider stall"
  - "The retried call took 2.7s against 17s for the first call and wrote no [llm:*] log lines"
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags: [canary, retry, negative-cache, cachedfetchjson, mcp, analyze-situation, deduct-situation]
---

# A canary retry inside the server's negative cache never reaches the upstream

## Problem

`scripts/mcp-tool-canary.mjs` retried a failed tool 15s after the failure. `cachedFetchJson` stores a null fetcher result as a negative sentinel for 120s by default (`CACHED_FETCH_NEGATIVE_TTL_SECONDS` in `server/_shared/redis.ts`). For any tool behind that cache, the retry got the cached failure back and could never absorb a transient fault. One OpenRouter stall on `deduct-situation` (#11251) therefore filed a canary issue.

## Symptoms

- The canary issue lists `Attempts: 2`, but production logs show only one upstream attempt. The paid leg timed out at 15.0s, then `:free` returned 429.
- The retry is fast (~2.7s) and has no provider log lines. Compare its duration to the first attempt before trusting "retried".

## What Didn't Work

- Treating it as the Nov 23 credit outage. OpenRouter `/api/v1/credits` showed a balance, and the log showed `timeout`, not `402`.
- Raising the 15s per-attempt cap. A 40-call uncapped probe finished every call within 10s, so a bigger cap is not shown to save the stalled calls.

## Solution

PR #11252:

- The canary runs every first attempt, then retries the failures in a second pass that starts 130s later (`RETRY_DELAY_MS`). A test pins the gap above `CACHED_FETCH_NEGATIVE_TTL_SECONDS`.
- The retry pass starts only if it can begin inside the run budget. A retry blocked by the budget keeps the first failure in place of reporting `budget_exhausted`.
- Real calls are counted per tool. A dependent that could not chain is retried with its upstream, and if its first real call, made in pass 2, fails, it gets pass 3.

## Why This Works

A retry tests the upstream only after every cache layer that remembers the failure has expired. A gap of 130s outlasts the default 120s sentinel. A single pass after all first attempts keeps green runs at their old length, and a mass outage costs one wait in place of one wait per failing tool.

## Prevention

- Before setting a monitor's retry delay, find the longest negative cache between the monitor and the upstream, and set the delay above it.
- Handlers with longer negative TTLs are still not covered: the trade tools (300s), company and SEC tools (300s) and market quotes (900s). A canary retry for those is still a cache hit.
- To get the real rate for this route, query `wm_api_usage` for `stage == 'deduct-situation'`, grouped by `provider`, `ok` and `reason`. The canary now hides single transient failures.
