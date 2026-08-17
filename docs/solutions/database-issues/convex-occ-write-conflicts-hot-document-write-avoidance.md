---
title: Convex OCC write conflicts on hot documents fixed by write-avoidance
date: 2026-08-13
category: database-issues
module: convex
problem_type: database_issue
component: database
symptoms:
  - "Convex Insights shows six 'Retried due to write conflicts' warnings across five functions in the production deployment (processWebhookEvent flagged on two tables)"
  - "apiKeys:touchKeyLastUsed hit 1,036 OCC conflicts on userApiKeys in 14 days (retry depth up to 3), concentrated on a few hot key documents"
  - "users:ensureRecord logged 1,618 conflicts in one day as concurrent tabs and auth-refresh storms rewrote the same users doc"
  - "payments/webhookMutations:processWebhookEvent re-patched the same customers row with identical userId/email during millisecond Dodo webhook bursts (~103 conflicts/14d)"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - authentication
  - payments
  - background_job
tags:
  - convex
  - occ
  - write-conflicts
  - hot-document
  - debounce
  - write-avoidance
  - axiom-convex-logs
  - mutation-retries
---

# Convex OCC write conflicts on hot documents fixed by write-avoidance

> Merge state: the fix is unmerged as of this writing (2026-08-13, session branch `worktree-sleepy-gliding-flask`). All file:line citations below are against that branch's working tree.

## Problem

Convex Insights raised six "Retried due to write conflicts" warnings across five functions — `apiKeys:touchKeyLastUsed`, `mcpProTokens:touchProMcpTokenLastUsed`, `users:ensureRecord`, `userPreferences:setPreferences`, and `payments/webhookMutations:processWebhookEvent` (flagged twice: once per contended table, `customers` and `subscriptions`). Convex uses optimistic concurrency control (OCC): a mutation that reads a document and later patches it conflicts with any concurrent mutation that wrote the same document first, and the loser is retried (up to a bounded depth) before becoming a permanent failure. Three independent write-amplification patterns were feeding the retry machinery with pointless writes:

1. **Scheduled-touch herd on hot credential docs.** `convex/http.ts` scheduled `apiKeys:touchKeyLastUsed` via `ctx.scheduler.runAfter` on **every** API-key validation. The gateway's Redis cache for key validation has a 60s TTL, so each hot key produced roughly one validation per minute per region. The mutation's internal 5-minute debounce (`convex/apiKeys.ts:282`) is a read-then-write: at each 5-minute boundary, every concurrently scheduled touch read the same stale `lastUsedAt` and all patched the same document. Result: 1,036 conflicts on `userApiKeys` in 14 days, retry depth up to 3, concentrated on ~7 hot key docs (top doc: 391 conflicts). `mcpProTokens:touchProMcpTokenLastUsed` mirrored the pattern (9 conflicts).

2. **Unconditional `lastSeenAt` patch.** `users:ensureRecord` patched the caller's `users` row on every call, so concurrent tabs and auth-refresh storms rewrote the same doc — 1,618 conflicts on 2026-07-28 alone, business-hours shaped (the client had only a per-tab in-flight guard).

3. **Identical-value webhook re-patch.** Dodo delivers related events for one purchase in a millisecond burst (`subscription.active` + `payment.succeeded` + `subscription.updated`); `payments/webhookMutations:processWebhookEvent` re-patched the same `customers` row with identical values each time (~103 conflicts/14d). The amplification driver is structural: `subscription.updated` with an active status forwards the original checkout's metadata into `handleSubscriptionActive`, so the active-handler path — including its customers upsert — re-runs on every routine renewal/update event for the life of the subscription (session history, PR #6364 session).

Two flagged functions were deliberately **not** changed: the `userPreferences:setPreferences` rate-limit counter is an exact per-user limiter whose same-user write serialization is the design (max retry depth 1, all absorbed), and the `subscriptions` patches carry webhook-ordering semantics in `updatedAt`.

Zero permanent OCC failures occurred in the 14-day window — retries absorbed everything. The fix removes the fuel before retry depth 3 becomes permanent failure under growth.

## Symptoms

- Convex Insights: "Retried due to write conflicts" warnings on `apiKeys:touchKeyLastUsed`, `mcpProTokens:touchProMcpTokenLastUsed`, `users:ensureRecord`, `payments/webhookMutations:processWebhookEvent`, `userPreferences:setPreferences`.
- Insights' Conflicting Document ID column showed heavy concentration on a handful of hot docs (top `userApiKeys` doc: 391 of 1,036 conflicts).
- Axiom `convex-logs` dataset, `data.occ_info.*` fields, confirmed retry depth (up to 3) and the daily shape (1,618 `users` conflicts on 2026-07-28). Note: `wm_api_usage` could not see any of this — it covers gateway routes only.
- No user-visible errors: zero permanent OCC failures in 14 days.

## What Didn't Work

**The in-mutation debounce alone.** `touchKeyLastUsed` already skipped the write when `lastUsedAt` was fresh (`convex/apiKeys.ts:282`) — and that check IS the read-then-write race. It runs inside the scheduled mutation, after `http.ts` had already enqueued one touch per validation. Inside the window the executions were harmless no-ops (only writers conflict), but at each 5-minute boundary the whole queued herd read the same stale timestamp, all decided the write was due, and all patched the same doc. A debounce inside the mutation cannot prevent the herd; it can only make retries of the losers no-ops.

**Attributing the Insights warnings to the concurrent "too many system operations" query timeouts.** Initially plausible — both showed up in the same Insights view — but disproven by telemetry: the `occ_info` stream had zero events in the stall minute, the heaviest OCC day had zero query timeouts, and the failure modes live on different sides of the engine (OCC is mutation-side write contention; the timeouts hit read-only queries, which cannot OCC-conflict at all). Two co-located warnings, two unrelated mechanisms.

**Read-avoidance on the users row (prior session).** The #6335 welcome-email session (PR #6364) first made the webhook activation handler skip the `users` row read entirely when a signed checkout-email stamp verified — and had to reverse it after review, because unconditional stamp precedence sends mail to a stale address whenever the users row is the fresher side. The durable outcome is the opposite constraint: the webhook handler *must* read `userRow.lastSeenAt` and compare it against the stamp's `issuedAt`, which makes `lastSeenAt` a load-bearing content clock, not just a touch stamp (session history). Any write-avoidance on `ensureRecord` has to be designed against that consumer — see Why This Works.

## Solution

Three write-avoidance changes, each verified red-first (test written and failing before the fix). Wire contracts are byte-identical throughout.

**1. Gate the touch at the schedule site** (`convex/http.ts:1120-1122`):

```ts
function touchIsDue(lastUsedAt: unknown): boolean {
  return typeof lastUsedAt !== "number" || lastUsedAt <= Date.now() - TOUCH_DEBOUNCE_MS;
}
```

Before, the route scheduled unconditionally; after, both validation routes schedule only when due:

```ts
// convex/http.ts:1159-1161 (API keys; MCP tokens mirror at :1329-1335)
if (result && touchIsDue(result.lastUsedAt)) {
  await ctx.scheduler.runAfter(0, (internal as any).apiKeys.touchKeyLastUsed, { keyId: result.id });
}
```

To feed the gate, `validateKeyByHash` now returns `lastUsedAt` (`convex/apiKeys.ts:241`) and `validateProMcpToken` returns `{ userId, lastUsedAt }` (`convex/mcpProTokens.ts:138`). The routes strip it before responding: the API-key route destructures it out (`convex/http.ts:1172-1174`) because the gateway caches the blob in Redis for 60s and its shape is load-bearing (`isUserKeyResult` in `api/_user-api-key.js`); the MCP route pins the body to exactly `{ userId }` (`convex/http.ts:1348`). `TOUCH_DEBOUNCE_MS` is exported once from `convex/apiKeys.ts:275` and imported by both `convex/http.ts:4` and `convex/mcpProTokens.ts:3` — single source, so the two halves of the debounce cannot drift. The in-mutation checks stay as the second line (`convex/apiKeys.ts:282`, `convex/mcpProTokens.ts:180`).

**2. Make `ensureRecord` read-only when nothing changed** (`convex/users.ts:143-155`):

```ts
if (!materialChange && now - existing.lastSeenAt < LAST_SEEN_REFRESH_WINDOW_MS) {
  return { ok: true as const, action: "unchanged" as const };
}
```

`LAST_SEEN_REFRESH_WINDOW_MS = 5 * 60 * 1000` is exported at `convex/users.ts:45` (matching the touch-debounce convention). `materialChange` (`convex/users.ts:147-152`) covers locale fields, explicitly provided timezone/country, and email changes. The #6335 invariant — any email rewrite stamps `lastSeenAt` in the same patch — holds because the skip requires the email to be identical; every taken write path still stamps `lastSeenAt` (`convex/users.ts:160`).

**3. Skip the identical customers upsert** (`convex/payments/subscriptionHelpers.ts:1127-1138`): when `userId`, `email`, and `normalizedEmail` are all unchanged, don't patch. Safe because no consumer reads `customers.updatedAt` (verified repo-wide, 2026-08-13); it is a bookkeeping stamp only.

**Tests — replicating the race without OCC.** True OCC conflicts cannot be produced in `convex-test`, so the tests replicate the *write amplification* instead: validate inside the debounce window, deliberately leave the scheduler undrained, advance the fake clock past the boundary (`vi.setSystemTime`), then drain (`t.finishAllScheduledFunctions(vi.runAllTimers)`). A touch that was wrongly queued now executes with a stale read and writes `T0+6min`; a gated route queued nothing, so `lastUsedAt` must stay at `T0`. Red before the fix (both routes wrote `T0+6min`), green after.

- `convex/__tests__/apiKeys.test.ts:479-556` — the three-phase gate test (`:512`, boundary drain at `:526-534`) plus the wire-contract pin: response keys exactly `["id", "name", "userId"]` (`:553`).
- `convex/__tests__/mcpProTokens.test.ts:571-612` — mirrored gate test; body pinned to `{ userId: "user-pro" }` at `:507-526`.
- `convex/__tests__/users.test.ts:304-393` — identical repeat inside window is read-only with `action: "unchanged"` (`:320`); repeat after window refreshes (`:341`); material change inside window writes immediately and stamps `lastSeenAt` (#6335, `:356`); first-time timezone counts as material (`:375`).
- `convex/__tests__/webhook.test.ts:162-213` — second identical-identity delivery leaves `updatedAt` untouched (`:172`); a changed email still rewrites (`:193`).

## Why This Works

In Convex OCC, **only executions that write can conflict**. Every one of the three changes converts a redundant write into no execution at all (the touch is never scheduled) or a read-only return (the mutation exits before `ctx.db.patch`). A read-only mutation cannot lose an OCC race, and an unscheduled job cannot pile up at a debounce boundary — the herd never forms, instead of being absorbed by retries after it forms.

The schedule-site gate specifically fixes the boundary-herd mechanism: with the gate, a fresh `lastUsedAt` means *nothing is queued*, so when the window expires there is no backlog of touches holding the same stale read — at most one validation (the first after expiry) schedules the one touch that actually writes. As a bonus, one scheduled job per validation disappears from the scheduler.

**Safety against the #6335 content-clock consumer.** The welcome-email handler picks an address by comparing `userRow.lastSeenAt` against the checkout stamp's `issuedAt`, so throttling `lastSeenAt` could in principle bias that pick toward the stamp. It cannot mis-deliver here: whenever the row's email differs from the current Clerk identity email, `materialChange` forces the write-and-stamp immediately, so the row loses the freshness comparison only while its address is *identical* to Clerk's — and between two sources holding equal addresses, either pick sends to the same place. `lastSeenAt` degrades only to a lower bound lagging true activity by at most 5 minutes. The mutation-proven freshness suites from the #6335 session (`convex/__tests__/webhook.test.ts`, `checkoutLoginEmailMetadata.test.ts`, `identitySigning.test.ts`) all pass against the fix (session history). A secondary benefit: that same handler *reads* the users row inside its transaction, so reducing `ensureRecord`'s write rate also de-conflicts the webhook-read vs `ensureRecord`-write pair on active users.

The correctness constraints all hold: gateway wire contracts are byte-identical (the new `lastUsedAt` field is stripped before the response on both routes, and tests pin both bodies), and the two semantics-carrying write sites (`setPreferences` rate limiting, `subscriptions.updatedAt` ordering) were left alone because their writes are load-bearing.

## Prevention

- **In Convex, only writing executions OCC-conflict — prefer write-avoidance over retry-absorption.** Gate at the schedule site (don't enqueue work whose input already proves it a no-op) and skip no-change patches (return before `ctx.db.patch` when the row would be identical). Removing the write removes the conflict class; retries merely hide it until depth runs out.
- **Scope the no-change skip: it applies to unconditional-patch mutations, not CAS-guarded ones.** The convex-gotchas skill reference `convex-occ-retry-vs-app-cas-conflict-different-layers` rejects "server-side no-op if unchanged" — correctly, for CAS-guarded mutations like `setPreferences`, where the syncVersion bump *is* the contract. Write-avoidance is a real lever only where the skipped write carries no semantics (touch stamps, identical upserts, unconditional heartbeats).
- **Before adding a skip-gate to previously-unconditional work, check what the redundancy was silently providing.** See `docs/solutions/design-patterns/deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing.md` — its checklist is exactly the #6335 analysis above (a "redundant" `lastSeenAt` stamp turned out to be a load-bearing content clock; the fix survives because email changes still force the write).
- **A debounce inside the mutation is the second line, not the fix.** The in-mutation freshness check is itself a read-then-write and races with every concurrently scheduled sibling at the window boundary. Keep it (it makes racing stragglers no-ops), but the primary gate belongs where the work is *scheduled*, sharing one exported constant so the two halves can't drift (`convex/apiKeys.ts:275` → `convex/http.ts:4`, `convex/mcpProTokens.ts:3`).
- **An exact rate limiter's conflicts are by-design — don't "fix" them.** A per-user exact counter serializes same-user writes on purpose; its OCC retries (depth 1, fully absorbed) are the mechanism working. "Fixing" it means changing its semantics (e.g. to a sharded/approximate limiter), which is a product decision, not a bug fix. Same for timestamps that carry ordering semantics, like `subscriptions.updatedAt`.
- **Read Convex Insights' Conflicting Document ID column first.** Hot-doc concentration (here: ~7 docs, top doc 391/1,036) tells you whether you have a systemic pattern or a few hot rows, and points straight at the amplification mechanism.
- **Axiom `convex-logs` `data.occ_info.*` is the queryable record** for retry depth, daily shape, and per-function conflict counts. `wm_api_usage` is gateway-routes-only and sees none of it. When counting failures there, always filter `data.topic == 'function_execution'` — bare `data.status != 'success'` also matches null-status telemetry topics and inflates counts ~500×.
- **Test the amplification, not the OCC.** `convex-test` cannot produce real OCC conflicts, but the herd is reproducible deterministically: queue work inside the debounce window, advance the fake clock past the boundary, then drain the scheduler (`t.finishAllScheduledFunctions(vi.runAllTimers)`). Assert on what the drained queue *wrote* — a wrongly queued job leaves a stale-read write behind; a gated site leaves the doc untouched.

## Related Issues

- `docs/solutions/design-patterns/deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing.md` — the counterweight checklist applied in Why This Works.
- `docs/solutions/integration-issues/vendor-sdk-hidden-retries-nested-retry-ladder.md` — same amplification theme (hidden layers multiplying work) in the same payments territory.
- convex-gotchas skill reference `convex-occ-retry-vs-app-cas-conflict-different-layers` — the CAS-race class behind the same Insights metric; this doc covers the complementary write-amplification class (see the scoping bullet in Prevention).
- #6335 / PR #6364 — the session that made `lastSeenAt` load-bearing and verified the webhook re-patch amplification mechanism.
- #6256 — same write-amplification class fixed the same way (unconditional per-transaction work gated at the call site).
- #5426 — Convex retry-contention adjacent (hung action holding an idempotency lock, retries 409ing).
