---
title: A schedule-site staleness gate cannot stop a concurrent Convex touch herd
date: 2026-10-16
category: database-issues
module: Convex key validation routes and lastUsedAt touches
problem_type: database_issue
component: database
symptoms:
  - "Convex Insights: 560 `OCC Retried` conflicts on `userApiKeys` from `apiKeys:touchKeyLastUsed` and 154 on `mcpProTokens` from `mcpProTokens:touchProMcpTokenLastUsed` in 72h"
  - "The conflicts continued after an earlier fix that gated scheduling on a stale `lastUsedAt`"
  - "Prod log pairs of touch runs 5 to 16 ms apart on one document, where `occInfo.writeSource` names the same touch function"
root_cause: async_timing
resolution_type: code_fix
severity: low
related_components:
  - authentication
tags:
  - convex
  - occ
  - write-conflict
  - scheduler
  - thundering-herd
  - last-used-at
  - convex-insights
  - local-backend
---

# A schedule-site staleness gate cannot stop a concurrent Convex touch herd

## Problem

Every API key, embed key, and Pro MCP token validation can schedule an internal mutation that bumps `lastUsedAt`. Bursts of parallel validations scheduled several touches on one document for the same instant, and all but one lost the OCC write race. Users saw nothing because the loser retries and no-ops. The cost was wasted mutation runs and Insights noise that buries real conflicts.

## Symptoms

- `npx convex insights --prod --details` listed `apiKeys.js:touchKeyLastUsed` (560 conflicts) and `mcpProTokens.js:touchProMcpTokenLastUsed` (154) as the top two warnings, almost all at `retries:0`.
- The 2026-08 fix (1,036 conflicts in 14 days) had moved the debounce check to the schedule site as `touchIsDue` in `convex/http.ts`, and the conflicts continued at a similar rate.

## What Didn't Work

- **Gating the schedule on a stale `lastUsedAt`.** The gate reads a snapshot outside any transaction. Every validation that lands between the 5-minute debounce expiring and the first touch committing still sees the old value, so a burst still schedules N touches. The gate stops repeat touches inside the window. It cannot stop the herd at the window's edge.
- **The in-mutation debounce check.** It is a read-then-write. N touches that start at the same instant all read the same stale value before any of them commits.
- **Reproducing with `convex-test`.** It runs transactions serially, so it can never show an OCC conflict. A unit test can pin the scheduling shape (see Prevention), but only a real backend shows the conflict.

## Solution

Schedule each touch at a random delay instead of `runAfter(0)` (PR #9169, `convex/http.ts`):

```ts
const TOUCH_SPREAD_MS = 30_000;

function touchDelayMs(): number {
  return Math.floor(Math.random() * TOUCH_SPREAD_MS);
}

// at each of the three validate routes
await ctx.scheduler.runAfter(touchDelayMs(), (internal as any).apiKeys.touchKeyLastUsed, { keyId: result.id });
```

The mutations are unchanged. `lastUsedAt` keeps its 5-minute debounce, so up to 30 seconds of lag is below its resolution.

## Why This Works

OCC conflicts need overlapping transactions on one document. With the delays spread over 30 seconds, the first touch usually commits before the next one starts. The later touches read the fresh `lastUsedAt`, hit the debounce, and return without writing. Two of those read-only no-ops can land together without conflicting, because neither writes.

The spread lowers the risk and does not remove it. A touch still conflicts when its delay lands within the first writer's run of about 20 ms. The expected count is about (N−1) × 20 ms / 30 s per burst of N, which is about 0.013 for a burst of 20. Serializing the touches instead would need a shared write target, which brings back the same conflict.

Measured on the real `/api/internal-validate-api-key` route, with the repo's functions deployed to a local backend. Each row is concurrent POSTs in bursts.

| Code | Bursts | Touch runs | OCC conflicts | Writes |
|---|---|---|---|---|
| `runAfter(0)` | 10 × 5 | 72 | 29 | 10 |
| random 0–30 s | 10 × 5 | 50 | 0 | 10 |
| random 0–30 s | 5 × 20 | 100 | 0 | 5 |

Writes stay at one per key. The trade is that every validation in a burst now schedules a touch, and the extras are cheap read-only runs.

## Prevention

- **Reproduce OCC on a real backend, not `convex-test`.** Download `convex-local-backend-<arch>.zip` from the `get-convex/convex-backend` GitHub releases. Start it with `--instance-name` and `--instance-secret`, and get an admin key with `convex-local-backend keygen admin-key`. Deploy from a `git archive` copy of the repo with its own `.env.local` holding `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`. A worktree's `.env.local` can carry the prod deploy key. `convex dev --local` is deprecated as of CLI 1.40.
- **Count conflicts from the log stream.** `convex logs --success --jsonl` emits one Completion per run with `occInfo` (`tableName`, `documentId`, `writeSource`) and `willRetry`. The same fields on prod confirm the mechanism, because `writeSource` names the transaction that won.
- **Pin the scheduling shape in a unit test.** `convex/__tests__/apiKeys.test.ts` pins `Math.random` to a fixed value for each of three validations and reads `ctx.db.system.query("_scheduled_functions")`. It asserts the exact scheduled times, so a longer spread also fails. Pin the value with `mockReturnValue` for the whole request, not `mockReturnValueOnce`. Something else in the request path also calls `Math.random`, and a queue of one-shot values gets consumed out of order.
- **Any best-effort write to a shared document from a fan-out path will herd.** A non-transactional "is it due" check cannot dedupe concurrent callers. Spread the writes in time, or give each caller its own write target.

Not every OCC warning is a bug. In the same Insights run, `payments/webhookMutations:processWebhookEvent` showed 38 conflicts on `subscriptions`. Dodo sends several events per billing action within seconds, and each is a distinct write to the same subscription. OCC serializes them, and the retry runs inside the same HTTP request. A captured case retried once and wrote. That is the correct behavior, so it was left alone.

## Related Issues

- PR #9169 adds the spread delay and the scheduling-shape test.
- [Convex's "request couldn't be completed" is redacted](../integration-issues/convex-request-couldnt-be-completed-is-redacted-join-request-id-into-axiom-convex-logs.md) covers another Convex diagnosis that reads the raw log stream.
