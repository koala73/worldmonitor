---
title: The MCP grant cap evicted an active connector instead of an idle one
date: 2026-11-07
category: logic-errors
module: mcp-oauth-grants
problem_type: logic_error
component: authentication
severity: high
symptoms:
  - "Glama marks the World Monitor connector unhealthy with \"Missing credentials: No OAuth access token\""
  - "Glama Test History shows failures of 3-7 ms right after a run of healthy checks"
  - "A connector loses its sign-in shortly after the same account authorizes another client"
root_cause: logic_error
resolution_type: code_fix
related_components: [service_object, testing_framework]
tags: [mcp, oauth, mcpprotokens, grant-cap, eviction, lru, glama, connector-health, convex]
---

# The MCP grant cap evicted an active connector instead of an idle one

## Problem

Each account holds at most five active MCP OAuth grants (`MAX_TOKENS_PER_USER` in `convex/mcpProTokens.ts`). A sixth authorization silently revoked the oldest-created grant, however recently it was used. Authorizing a new client could therefore cut off a connector that was in use at that moment, with no notice to the user.

## Symptoms

- On 2026-11-07, Glama emailed that World Monitor was unhealthy: "Missing credentials: No OAuth access token". It had sent the identical email on 2026-10-21.
- Glama's Test History showed hourly successes up to 11:40 (+04:00), then failures at 12:41 and 13:42 that took 3 ms and 7 ms. Failures that fast suggest Glama did not reach our server. `wm_api_usage` confirmed it: there was no request from Glama's checker after 07:40:41 UTC. It had no usable token on its own side.

## What Didn't Work

- **Blaming the connect-time challenge.** An anonymous `initialize` gets a 401 challenge, and that rule has been unchanged since at least 2026-10-01 (`api/mcp/handler.ts`, `challengeAnonymous`). It explains why Glama needs a token, not why the token disappeared.
- **Blaming that day's MCP deploy.** #10293 changed only the `api.worldmonitor.app` alias. Glama checks `https://worldmonitor.app/mcp`.
- **Looking for a refresh failure in logs.** The token endpoint emits usage rows only for rate limits (`emitOAuthTokenUsage` in `api/oauth/token.ts`), and Vercel runtime logs carry no line for a successful refresh or an `invalid_grant`. Neither source can show a refresh being rejected.

## Solution

**Diagnosis:**

1. **Identify the checker.** Match the times of Glama's healthy checks against `wm_api_usage`. Glama sends User-Agent `node` from 40.160.65.14, authenticated, at roughly :37–:41 past each hour, and it also runs an anonymous pass near :15. That gave the account and showed its last successful call at 07:40:45 UTC.
2. **List the account's grant rows.** Run `npx convex data mcpProTokens --limit 5000 --format jsonLines`, with `CONVEX_DEPLOY_KEY` parsed from the main checkout's `.env.local`, and filter to the account. Without `--limit` the command returns only the 100 newest rows of the whole table, about 1,000 rows on 2026-11-07, so it can miss the account's older grants. Keep revoked rows: they carry the evidence. Check that the total row count is below the limit. If it is not, raise the limit so no rows are cut off.
   - The "Connected via Glama" row had `revokedAt` 07:57:09, which is exactly the `createdAt` of a new "Connected via Claude" row.
   - Rows unused since October survived.
   - The 2026-10-21 rows showed the same pattern.

**Fix (PR #10297).** Rotation now revokes the grants unused for longest: `lastUsedAt`, else `createdAt`. The race convergence is kept, so the active set still trims to MAX-1 before each insert.

```ts
const active = await ctx.db
  .query("mcpProTokens")
  .withIndex("by_userId_revokedAt_createdAt", (q) => q
    .eq("userId", args.userId)
    .eq("revokedAt", undefined))
  .collect();
if (active.length >= MAX_TOKENS_PER_USER) {
  const lastActivity = (row) => row.lastUsedAt ?? row.createdAt;
  const toRevoke = active
    .sort((a, b) => lastActivity(a) - lastActivity(b) || a.createdAt - b.createdAt)
    .slice(0, active.length - (MAX_TOKENS_PER_USER - 1));
  // patch each with revokedAt
}
```

The regression test seeds the production row set. It failed before the fix, because the Glama row came back revoked.

## Why This Works

A hosted connector or health checker typically completes OAuth once and then refreshes for weeks, so its row is old by creation date but recent by use. Creation order is the wrong signal for eviction. Last use picks the grant whose client has actually gone away.

Reconnects make this worse. claude.ai and other hosts may register a new client and mint a new grant on each reconnect, so a busy account churns through the cap quickly.

`lastUsedAt` is debounced to 5 minutes (`TOUCH_DEBOUNCE_MS`), which is fine-grained enough for this ordering. Only authenticated MCP requests record use: a token refresh validates the grant with `recordUsage: false` (`api/oauth/token.ts`). A client that refreshes but never calls a tool therefore still looks idle and can be evicted.

## Prevention

- An eviction rule for credentials should order by last use, never by creation time. Pin it with a test where the oldest-created row is also the most recently used.
- For any report that a connector lost its sign-in, list the account's `mcpProTokens` rows and compare each `revokedAt` with new `createdAt` times before suspecting the client.
- In a third-party checker's history, a failure that takes a few milliseconds suggests that check never called our MCP endpoint. Confirm it against `wm_api_usage` for the checker's IP. If nothing arrived, the credential was already gone. It may have been lost to a revoked grant or to an earlier rejected refresh, after which the client discarded its tokens. Check grant rows and refresh outcomes, not the transport.

## Related Issues

- PR #10297: the fix.
- PR #10293: served MCP on `api.worldmonitor.app` again. It is unrelated to this failure, but it is why the owner's Claude connector reconnected that morning.
- `docs/solutions/integration-issues/cimd-live-fetch-must-not-burn-one-shot-oauth-codes.md`: another way an OAuth step on the same flow loses a credential.
