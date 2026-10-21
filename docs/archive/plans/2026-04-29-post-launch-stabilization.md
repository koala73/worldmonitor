# Post-Launch Stabilization Plan

**Date:** 2026-04-29
**Author:** Elie + Claude (incident-driven)
**Status:** ✅ APPROVED by Codex (gpt-5.5) round 6 — ready to execute
**Revision history:**

- 2026-04-29 r1: initial plan
- 2026-04-29 r2: addressed 8 Codex round-1 findings (Convex action/mutation split, lease preservation, chunked persistence, fetch redirect bypass, schema field names, paid-through cancellation policy, Sentry signature, rollback runbook)
- 2026-04-29 r3: addressed 6 Codex round-2 findings (refund amount source — rawPayload not row column; per-contact tri-state status; mutation→mutation calls forbidden; in-flight guard timestamp fallback; chunked discard-deletion; Clerk userId is string)
- 2026-04-29 r4: addressed 5 Codex round-3 findings (per-row CAS no-op-unless-pending guard; broadcast-created recovery branch; finalize action explicit partial-failure recording; waveRuns underfill fields; ctx.scheduler.runAfter wording)
- 2026-04-29 r5: addressed 3 Codex round-4 findings (`_markPickFailed` covering empty pool / createSegment fail / persist fail; duplicate Resend calls acknowledged as acceptable due to upsert idempotency; `resumeFinalizeWaveRun` operator-verification requirement for send-failure case)
- 2026-04-29 r6: addressed 1 Codex round-5 finding (contradiction — `resumeStalledWaveRun` previously branched into `broadcast-created` without the `confirmedNotSent` safety gate; now refuses `broadcast-created` and routes operator to `resumeFinalizeWaveRun` which enforces verification)

## Context

The PRO-launch broadcast week surfaced eight distinct production issues over 48
hours. Five are real (one already fixed in `#3449`); three are dashboard noise.
This plan addresses the remaining seven, ordered by leverage and grouped into
three parallelizable PRs.

## Inventory & status

| # | Problem | Severity | Disposition |
|---|---|---|---|
| 1 | Refund doesn't auto-revoke entitlement (`refund.succeeded`) | High | PR 1 — alert-only (no auto-revoke per ops decision) |
| 2 | Stale frontend bundles cause CONFLICT retry storms (the `setPreferences` 50% spike) | High | PR 1 — force-reload on tab focus |
| 3 | Wave-loading times out at >1500 contacts; 5000/15000/25000 waves blocked | High | PR 2 (parallel lane) — state-machine rebuild |
| 4 | `setPreferences` Convex Insights noise (CAS guard counted as failure) | Medium | PR 3 — throw→return |
| 5 | Missing `subscription.updated` webhook handler | Medium | PR 3 — add handler (paid-through-aware) |
| 6 | `_stampWaveByNormalizedEmail` write conflict | Low | Subsumed by PR 2 (smaller batches → no contention window) |
| 7 | `processWebhookEvent` self-conflict on `subscriptions` | Low | Defer — auto-retry handles correctness; cost ≫ value |
| 8 | `recordBroadcastEvent` OCC counter | — | **Already fixed in #3449** |

## Sequencing

```
Lane 1 (urgency) ─ PR 1 (Day 1) ────── soak 24h ────── PR 3 (Day 4)
Lane 2 (eng work) ─────────── PR 2 (Day 2-3) ──────────────────────
```

PR 1 ships first — smallest fix, highest leverage (permanently neutralizes
a class of bug that recurs on every wire-shape change). PR 2 runs in parallel
— isolated module rebuild with no overlap to PR 1's surface. PR 3 ships last
because (E) is intentionally gated on PR 1 having ≥24h of soak: verify the
storm decays naturally before suppressing the surface that proves it.

## PR 1 — Stale-bundle reload + Sentry tags + refund alert

**Tracker:** Task #24
**Estimated effort:** ~3 hours
**Files changed:** ~6

### A. Stale-bundle force-reload on tab focus

**Why:** the `setPreferences` 50% failure rate today is one stuck-bundle user
clinging to a pre-`#3466` JS bundle. The fix in `#3466` shipped 2026-04-27;
any tab open before that date is permanently broken until refreshed. This
class will recur on every future wire-shape change unless we close the door.

**Codex r1 finding addressed:** `installWebApiRedirect()` (src/main.ts:655)
rewrites `/api/*` fetches to the canonical API host. A `/api/build-version`
endpoint would compare the frontend bundle to the API-deployment hash, not
the web-deployment hash. Resolution: serve the hash as a same-origin static
asset OUTSIDE the `/api/*` namespace, so the redirect doesn't touch it.

**Changes:**

1. `vite.config.ts` line 652 — add to `define:` block:

   ```ts
   __BUILD_HASH__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'),
   ```

2. `src/types/globals.d.ts` (or wherever `__APP_VERSION__` is declared) —
   add `declare const __BUILD_HASH__: string;`
3. New Vite plugin (in `vite.config.ts` plugins array) — emit
   `dist/build-hash.txt` with the SHA at build time:

   ```ts
   {
     name: 'emit-build-hash',
     apply: 'build',
     generateBundle() {
       this.emitFile({
         type: 'asset',
         fileName: 'build-hash.txt',
         source: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
       });
     },
   }
   ```

   Result: `https://<frontend-host>/build-hash.txt` returns the SHA as plain
   text. Same-origin (frontend host, not API host). No `/api/*` prefix → not
   touched by `installWebApiRedirect()`.
4. New `src/utils/stale-bundle-check.ts`:

   ```ts
   const MIN_INTERVAL_MS = 60_000;
   let _lastCheckedAt = 0;

   export function installStaleBundleCheck(): void {
     window.addEventListener('focus', async () => {
       const now = Date.now();
       if (now - _lastCheckedAt < MIN_INTERVAL_MS) return;
       _lastCheckedAt = now;
       try {
         // Same-origin static asset; bypasses installWebApiRedirect by design
         // (only /api/* is rewritten). Cache-bust to defeat any intermediate
         // proxy.
         const res = await fetch(`/build-hash.txt?t=${Date.now()}`, { cache: 'no-store' });
         if (!res.ok) return;
         const hash = (await res.text()).trim();
         if (hash && hash !== __BUILD_HASH__ && hash !== 'dev') {
           console.warn('[stale-bundle] reload:', __BUILD_HASH__, '→', hash);
           window.location.reload();
         }
       } catch { /* offline; skip */ }
     });
   }
   ```

5. Wire `installStaleBundleCheck()` in `src/main.ts` AFTER
   `installWebApiRedirect()` (no ordering coupling, but conceptually
   "after the boot is done").

**Tests:**

- `tests/stale-bundle-check.test.mjs` — mock fetch, assert reload-on-mismatch,
  assert no-reload-on-match, assert no-reload-on-`'dev'`-marker, assert
  60s dedupe window.

**Verification:**

- Deploy to a Vercel preview, copy URL, copy `BUILD_HASH` from
  `dist/build-hash.txt`.
- Trigger redeploy with no-op commit (new SHA).
- Open original preview URL; blur+refocus → expect hard reload.
- Confirm `installWebApiRedirect()` does NOT rewrite `/build-hash.txt`
  (network tab should show same-origin fetch).

**Rollback:** delete the focus listener wiring in `src/main.ts`. The Vite
plugin still emits `build-hash.txt` (harmless static file). `__BUILD_HASH__`
still defined (harmless constant).

### B. Sentry capture for `setPreferences` CONFLICT

**Codex r1 finding addressed:** current `buildSentryContext()` at
`api/user-prefs.ts:206` computes `error_shape` internally from the message
string and puts `userId` in `extra`, not as a Sentry tag. We need both an
explicit override AND `userId` as a tag for grouping.

**Changes:**

1. `api/user-prefs.ts:206` — extend `buildSentryContext` signature:

   ```ts
   function buildSentryContext(
     err: unknown,
     msg: string,
     opts: {
       method: string;
       convexFn: string;
       userId: string;
       variant?: string;
       ctx: ExecutionContext | undefined;
       schemaVersion?: number | null;
       expectedSyncVersion?: number;
       blobSize?: number;
       errorShapeOverride?: string;       // NEW
       extraTags?: Record<string, string | number>; // NEW — for actualSyncVersion etc.
     },
   ): SentryContext {
     // existing logic — but if opts.errorShapeOverride is set, skip the
     // message-pattern classification and use it directly.
     const errorShape = opts.errorShapeOverride ?? classifyShape(err, msg);
     // ...
     return {
       tags: {
         convex_request_id: requestId,
         error_shape: errorShape,
         user_id: opts.userId,                     // NEW — promote from extra
         ...(opts.extraTags ?? {}),
       },
       extra: { ...existing extras (variant, schemaVersion, etc.) },
       fingerprint: [opts.method, opts.convexFn, errorShape],
     };
   }
   ```

2. `api/user-prefs.ts:144` — add capture before returning the 409:

   ```ts
   const actualSyncVersion = readConvexErrorNumber(err, 'actualSyncVersion');
   captureSilentError(err, buildSentryContext(err, msg, {
     method: 'POST',
     convexFn: 'userPreferences:setPreferences',
     userId: session.userId,
     variant: body.variant,
     ctx,
     schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : null,
     expectedSyncVersion: body.expectedSyncVersion,
     blobSize: body.data !== undefined ? JSON.stringify(body.data).length : 0,
     errorShapeOverride: 'setPreferences_conflict',
     extraTags: actualSyncVersion !== undefined ? { actual_sync_version: actualSyncVersion } : undefined,
   }));
   return jsonResponse(
     actualSyncVersion !== undefined ? { error: 'CONFLICT', actualSyncVersion } : { error: 'CONFLICT' },
     409,
     cors,
   );
   ```

**Tests:**

- Existing 409 response-shape tests pass unchanged.
- New unit: when CONFLICT is caught, `captureSilentError` is called once
  with `tags.error_shape === 'setPreferences_conflict'` and `tags.user_id`
  is a non-empty string (Clerk user IDs are opaque strings like
  `user_2x8K3...`, not numbers; assertion is "string and present", not
  "numeric").

**Verification:**

- Sentry → query `error_shape:setPreferences_conflict` → group by `user_id`
  → expect distribution to narrow within 24h post-(A)-deploy.

### C. Refund-without-prior-cancellation Sentry alert

**Codex findings addressed:**

- **r1:** schema uses `cancelledAt` (camelCase) — fixed.
- **r2:** the `subscriptions` row schema (`schema.ts:286`) has only
  `userId, dodoSubscriptionId, dodoProductId, planKey, status,
  currentPeriodStart, currentPeriodEnd, cancelledAt, rawPayload, updatedAt`.
  There is NO `recurringPreTaxAmount` column. The reference at
  `subscriptionHelpers.ts:516` passes the value to email scheduling but
  doesn't persist it. Fix: read from `sub.rawPayload?.recurring_pre_tax_amount`
  defensively. (Alternative — adding a top-level column with backfill —
  is bigger surgery and out of scope for an alert-only feature.)

**Changes:**

`convex/payments/subscriptionHelpers.ts` — in `handlePaymentOrRefundEvent`,
after writing the `paymentEvents` row but before returning:

```ts
if (eventType === 'refund.succeeded' && data.subscription_id) {
  const sub = await ctx.db
    .query('subscriptions')
    .withIndex('by_dodoSubscriptionId', (q) =>
      q.eq('dodoSubscriptionId', data.subscription_id!),
    )
    .unique();
  if (sub && sub.status === 'active' && !sub.cancelledAt) {
    const refundAmount = data.total_amount ?? data.amount ?? 0;
    // recurring_pre_tax_amount is NOT a top-level column on the
    // subscriptions row — read defensively from rawPayload (the original
    // Dodo subscription payload, snake_case).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPayload = sub.rawPayload as any;
    const subAmount = typeof rawPayload?.recurring_pre_tax_amount === 'number'
      ? rawPayload.recurring_pre_tax_amount
      : 0;
    // Treat refund as "full" when within 1% (rounding/tax tolerance).
    const isFullRefund = subAmount > 0 && refundAmount >= subAmount * 0.99;
    if (isFullRefund) {
      console.error(
        `[refund-alert] full refund without prior cancellation: ` +
        `subId=${data.subscription_id} userId=${sub.userId} ` +
        `refund=${refundAmount} subAmount=${subAmount}`,
      );
      // Convex auto-Sentry captures console.error.
    } else if (subAmount === 0) {
      // Defensive: rawPayload missing recurring_pre_tax_amount means we
      // can't classify. Log for visibility but don't false-positive alert.
      console.warn(
        `[refund-alert] refund on active sub but cannot classify amount: ` +
        `subId=${data.subscription_id} userId=${sub.userId} ` +
        `refund=${refundAmount} (rawPayload.recurring_pre_tax_amount missing)`,
      );
    }
  }
}
```

**Tests:**

- Unit: full refund + active sub + no cancelledAt + rawPayload has
  recurring_pre_tax_amount → console.error called.
- Unit: partial refund (50% amount) + active sub → no console.error.
- Unit: full refund + already-cancelled sub (`cancelledAt` set) → no error.
- Unit: refund + active sub + rawPayload missing the field → console.warn
  (not error; can't classify without false-positive risk).
- Unit: refund event with no `subscription_id` (one-time payment) → no log.

**Verification:**

- Manually trigger a test refund on a sandbox sub; confirm Sentry event
  arrives within 1 min with `[refund-alert]` prefix.

**Rollback:** revert the new branch. Audit trail preserved (still inserts
`paymentEvents` row).

### Acceptance criteria for PR 1

- [ ] `https://<host>/build-hash.txt` returns the deployed SHA as plain text
- [ ] `__BUILD_HASH__` defined in bundle and matches deployed SHA
- [ ] Sentry receives `error_shape:setPreferences_conflict` events with
      `user_id` tag (queryable, groupable)
- [ ] Convex auto-Sentry receives `[refund-alert]` event for the next manual
      full-refund test on an uncancelled sub

## PR 2 — Wave-loading state machine rebuild

**Tracker:** Task #25
**Estimated effort:** ~1 working day
**Files changed:** ~10

**Codex r1 findings addressed:**

- Convex actions cannot do DB work directly → architecture explicitly splits
  into `internalAction` (external I/O) and `internalMutation` (DB work);
  pattern follows existing `audienceWaveExport.ts` precedent.
- Lease/in-flight guard → preserve existing `broadcastRampConfig.pendingRunId`
  semantics; every scheduled action re-validates lease on entry; `runDailyRamp`
  cron-tick guard refuses to start a new wave when a `waveRuns` row exists
  with in-flight status.
- 25k bulk insert too large → chunked persistence at ~500 rows per
  internalMutation, repeated from the picking action.
- Resend 429/5xx → exponential backoff with jitter, max 3 retries per
  contact, surface as `failed` only when all retries exhausted.
- Recovery for `failed` and stale `pushing` → explicit `discardWaveRun` and
  `resumeStalledWaveRun` operator mutations.

### Architecture

Replace monolithic `assignAndExportWave` with a state machine where each step
is bounded well below the 10-min Convex action runtime budget at any wave
size, and DB work is done exclusively in internal mutations.

**State tables (new in `convex/schema.ts`):**

```ts
waveRuns: defineTable({
  runId: v.string(),                    // unique per pickWave call
  waveLabel: v.string(),                // "pro-launch-wave-N"
  segmentId: v.optional(v.string()),
  status: v.union(
    v.literal('picking'),
    v.literal('segment-created'),
    v.literal('pushing'),
    v.literal('broadcast-created'),
    v.literal('sent'),
    v.literal('failed'),
  ),
  requestedCount: v.number(),           // operator-supplied; may exceed pool
  totalCount: v.number(),               // = picked.length (after sample)
  underfilled: v.boolean(),             // true if totalCount < requestedCount
  pushedCount: v.number(),
  failedCount: v.number(),
  batchSize: v.number(),
  lastBatchAt: v.optional(v.number()),
  broadcastId: v.optional(v.string()),
  // Sub-status for failures, so operator recovery can branch correctly:
  //   'create-broadcast-failed'   → segment ready, no broadcast yet
  //   'send-broadcast-failed'     → segment + broadcast both ready, send failed
  //   'discarded-by-operator'     → operator chose not to proceed
  //   'batch-failure-rate-exceeded' → push-side >5% failures
  failureSubstatus: v.optional(v.string()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index('by_runId', ['runId'])
  .index('by_status', ['status']),

wavePickedContacts: defineTable({
  runId: v.string(),
  normalizedEmail: v.string(),
  // Tri-state: pending = needs push, pushed = success, failed = exhausted retries.
  // Finalization gates on "no rows with status='pending' for this runId",
  // not on pushedCount === totalCount.
  status: v.union(v.literal('pending'), v.literal('pushed'), v.literal('failed')),
  pushedAt: v.optional(v.number()),
  failedAt: v.optional(v.number()),
  failedReason: v.optional(v.string()),
}).index('by_runId_status', ['runId', 'status'])
  .index('by_runId', ['runId']),
```

**Counters on `waveRuns`:** in addition to `pushedCount`, track
`failedCount`. Finalization threshold: `failedCount / totalCount > 0.05`
flips `waveRuns.status='failed'`; otherwise the wave proceeds to
`finalizeWaveAction` once `pending` count reaches 0.

### Function-shape rules (Convex-correct)

| Function | Type | Allowed work | Forbidden work |
|---|---|---|---|
| `pickWaveAction` | `internalAction` | Resend `createSegment`; reservoir-sample via `runQuery`; persist via `runMutation` | DB read/write directly |
| `_claimWaveRunLease` | `internalMutation` | Acquire `pendingRunId` lease; insert `waveRuns` row | External I/O |
| `_persistPickedBatch` | `internalMutation` | Insert ≤500 `wavePickedContacts` rows | External I/O |
| `_markPickComplete` | `internalMutation` | Patch `waveRuns.status='segment-created'`, `totalCount` | External I/O |
| `pushBatchAction` | `internalAction` | Resend `upsertContactToSegment`; per-row call to `_markContactPushed` OR `_markContactFailed`; schedule next batch | DB read/write directly |
| `_markContactPushed` | `internalMutation` | **Atomic single-row commit with CAS guard**: load `wavePickedContacts` row; if `status !== 'pending'` → return `{ok:false, reason:'not-pending'}` no-op (idempotent against double-marking from overlapping `pushBatchAction` invocations or operator-resume-while-original-still-running). Else: patch row to `status='pushed'`, increment `waveRuns.pushedCount`, AND inline-stamp the matching `registrations` row (since mutations cannot call other mutations via `ctx.runMutation`, the stamp logic from `_stampWaveByNormalizedEmail` is duplicated/inlined here, with the same `alreadyStamped` early-return). | External I/O; calling other mutations |
| `_markContactFailed` | `internalMutation` | **CAS guard:** no-op unless `status === 'pending'`. Else: patch `wavePickedContacts.status='failed'`, `failedReason`, increment `waveRuns.failedCount`. Does NOT stamp. If the new `failedCount/totalCount > 0.05`, ALSO atomically flip `waveRuns.status='failed', failureSubstatus='batch-failure-rate-exceeded'`. | External I/O |
| `_resumeBatchInfo` | `internalQuery` | Return remaining-pending count + run state for action's resume/finalize decision | n/a |
| `finalizeWaveAction` | `internalAction` | Call `createProLaunchBroadcast` + `sendProLaunchBroadcast`; call `_finalizeWaveRun` | DB read/write directly |
| `_finalizeWaveRun` | `internalMutation` | Reconcile `broadcastRampConfig.lastWave*`, advance tier, clear lease, mark `waveRuns.status='sent'` | External I/O |
| `discardWaveRun` | `internalMutation` (operator, soft-discard) | Mark `waveRuns.status='failed'` with reason='discarded-by-operator', rotate `waveLabelOffset`, clear lease. Does NOT physically delete `wavePickedContacts` rows (those are pruned by a scheduled cleanup action — see below). | External I/O |
| `_cleanupDiscardedWavePickedContacts` | `internalMutation` (scheduled, chunked) | Delete up to 500 `wavePickedContacts` rows for runs marked `failed`/`discarded` and older than 24h. Self-schedules next batch via the calling action wrapper if more remain. | External I/O; scheduling itself |
| `cleanupDiscardedWavePickedContactsAction` | `internalAction` (scheduled daily via cron OR triggered from `discardWaveRun`) | Loops: call `_cleanupDiscardedWavePickedContacts`; if it reports rows-remaining, schedule itself. | DB write directly |
| `_markPickFailed` | `internalMutation` | Atomic pick-phase failure recorder. Args: `{runId, substatus: 'empty-pool' | 'segment-create-failed' | 'persist-failed', error}`. Marks`waveRuns.status='failed'` with substatus + error. **Lease policy:** for `'empty-pool'` ALSO clears `broadcastRampConfig.pendingRunId` and patches `lastRunStatus='no-op-empty-pool'` (terminal — operator may resume next cycle when pool refills). For `'segment-create-failed'` and `'persist-failed'` keeps the lease HELD so the next cron tick refuses to start a new wave; operator must explicitly `discardWaveRun` to clear (segment may exist on Resend side and need manual cleanup). | External I/O |
| `markFinalizeRecovered` | `internalMutation` (operator, one-shot) | For the case where `failureSubstatus='send-broadcast-failed'` BUT operator-verifies-in-Resend-dashboard the broadcast was actually queued and sent. Args: `{runId, sentAt: number}`. Calls `_finalizeWaveRun` internals directly (advances tier, records success, clears lease) without retrying the send. | External I/O |
| `resumeStalledWaveRun` | `internalMutation` (operator) | Branches by current `waveRuns.status`: `pushing`/`segment-created` → re-arm `lastBatchAt = now()` and schedule `pushBatchAction({runId, batchN: 0})`. **Refuses `broadcast-created`** with an error directing the operator to use `resumeFinalizeWaveRun({confirmedNotSent: true})` (after Resend-dashboard verification) OR `markFinalizeRecovered({runId, sentAt})` if Resend shows already-sent. **Refuses `failed`** with any substatus — operator must use `resumeFinalizeWaveRun` (for `create-broadcast-failed` / `send-broadcast-failed`) or `discardWaveRun` (for `batch-failure-rate-exceeded`). **Refuses `sent`**. Idempotent — relies on per-row CAS guards in `_markContact*` mutations. | External I/O |
| `resumeFinalizeWaveRun` | `internalMutation` (operator) | The ONLY operator path to recover finalize-stage failures (`broadcast-created`, `failed/create-broadcast-failed`, `failed/send-broadcast-failed`). Branches by current status: `broadcast-created` (or `failed/send-broadcast-failed`) → REQUIRES arg `confirmedNotSent: boolean=true` (mutation throws on default-false with error directing operator to verify in Resend dashboard; Resend may have queued the send despite the action seeing an error response); when confirmed, schedules `finalizeWaveAction({runId})` which sees `broadcast-created` and retries only the send step using stored `broadcastId`. `failed/create-broadcast-failed` → no `confirmedNotSent` required (no broadcast yet); patches status back to `pushing` then schedules `finalizeWaveAction` to retry create+send. Refuses for any other status. If operator instead verified the broadcast WAS sent → use `markFinalizeRecovered`. | External I/O |

**Note on (`_markContactPushed` inline-stamps):** the existing public
`_stampWaveByNormalizedEmail` continues to exist for any pre-existing
caller. PR 2 inlines its body into `_markContactPushed` (≈10 lines:
query by `normalizedEmail`, idempotency check, patch). DRY trade-off
accepted because Convex forbids mutation→mutation `ctx.runMutation`.

### Step flow

**1. `pickWaveAction(waveLabel, count, batchSize=250)`:**

- Refuse if `_hasWaveLabel(waveLabel)` returns true.
- Call `_claimWaveRunLease({waveLabel, runId, count, batchSize})`. Mutation
  returns `{ok: false, reason: 'lease-held'}` if `pendingRunId` is set OR
  if any active `waveRuns` row exists with status in `{picking, segment-created, pushing}`.
  Action throws if lease refused.
- Reservoir-sample via existing `_getRegistrationsPage` paginated reads
  (already an internalQuery — same-pattern as `audienceWaveExport.ts`).
- **Empty-pool guard:** if `picked.length === 0`, call
  `_markPickFailed({runId, substatus:'empty-pool', error:'no unstamped registrations'})`
  and return. Mutation marks the run failed AND clears the lease (terminal
  no-op — operator will retry next cycle when pool refills).
- Resend `createSegment(name=pro-launch-${waveLabel})`. Wrap in try/catch:
  on failure, call
  `_markPickFailed({runId, substatus:'segment-create-failed', error: err.message})`
  and return. Lease stays held — operator must `discardWaveRun` after
  inspecting Resend dashboard.
- Loop: chunk picked emails into 500-row batches; for each chunk call
  `_persistPickedBatch({runId, contacts: chunk})`. ~50 mutations for 25k.
  Wrap the loop in try/catch: on any persist failure, call
  `_markPickFailed({runId, substatus:'persist-failed', error: err.message})`.
  Resend segment will exist but be empty/partial; operator may
  `discardWaveRun` (requires manual Resend segment delete).
- Call `_markPickComplete({runId, segmentId, totalCount: picked.length, underfilled: picked.length < requestedCount})`.

**Underfill policy:** when `picked.length < requestedCount` (e.g. requested
5000 but only 3200 unstamped registrations remain in the pool), the wave
PROCEEDS with the smaller cohort. This matches the existing
`assignAndExportWave` underfilled-flag behavior (`audienceWaveExport.ts:262-263`).
The `underfilled` boolean lets `getRampStatus` and operator dashboards
flag the condition, and `runDailyRamp` (or operator) can decide whether
to extend the curve or accept the smaller wave on subsequent ticks.
Halting on underfill would force operator intervention every time the
waitlist is naturally drained — too aggressive.

- Schedule first `pushBatchAction({runId, batchN: 0})` via
  `ctx.scheduler.runAfter(0, internal.broadcast.waveRuns.pushBatchAction, args)`.

**2. `pushBatchAction({runId, batchN, batchSize=250})`:**

- Re-validate lease + status via `_resumeBatchInfo({runId})`. Refuse if
  `waveRuns.status` not in `{segment-created, pushing}` OR if
  `broadcastRampConfig.pendingRunId !== waveRuns.runId`. Refuse also if
  `waveRuns.status === 'failed'` (rollback marker — see runbook).
- Patch `waveRuns.status='pushing'` on first batch (via internalMutation
  `_markPushingStarted` if not already).
- Query `pending`-status contacts via internalQuery
  `_getPendingBatch({runId, limit: batchSize})` (uses
  `by_runId_status` index).
- For each contact: call `upsertContactToSegment(apiKey, email, segmentId)`
  with exponential-backoff wrapper (250ms/500ms/1s, jitter ±20%, max 3
  retries on 429/5xx; honors retry-after header on 429).
  - Push success → call `_markContactPushed({runId, email})`. The mutation
    atomically patches the contact row to `status='pushed'`, bumps
    `waveRuns.pushedCount`, and inline-stamps the registration.
  - Push final-failure (all retries exhausted) → call
    `_markContactFailed({runId, email, reason})`. The mutation patches
    contact row to `status='failed'`, bumps `waveRuns.failedCount`, and
    if the new `failedCount/totalCount > 0.05` ALSO flips
    `waveRuns.status='failed'`.
- After batch: re-read `_resumeBatchInfo`. If `waveRuns.status='failed'`,
  exit (the threshold-trip already recorded the failure). Otherwise:
  - If `pendingCount > 0`: schedule
    `pushBatchAction({runId, batchN: batchN+1})`.
  - Else (no pending remain, no threshold trip): schedule
    `finalizeWaveAction({runId})`.

**Note on finalization gate:** the wave finalizes when zero contacts
remain in `pending` state, INDEPENDENT of the absolute push success
count. `failed` contacts are tolerated up to the 5% threshold; rows
above that threshold flip the whole run to `failed` instead.

**3. `finalizeWaveAction({runId})`:**

- Re-validate lease + status. Must be `pushing` (first call) OR
  `broadcast-created` (resume-after-send-failure path — see below).
- **If status is `pushing`:**
  - Try `createProLaunchBroadcast({segmentId, nameSuffix: waveLabel})`.
    - On failure: call
      `_markFinalizeFailed({runId, substatus:'create-broadcast-failed', error})`.
      Mutation flips `waveRuns.status='failed'` with the substatus
      preserving `segmentId`. Lease remains held; operator must run
      `discardWaveRun` (segment is wasted) OR `resumeFinalizeWaveRun`
      (which retries `createProLaunchBroadcast`). Exit.
    - On success: call `_markBroadcastCreated({runId, broadcastId})`
      which patches `waveRuns.status='broadcast-created', broadcastId,
      lastBatchAt = now()` (re-arms in-flight guard for the send phase).
- **(Now status is `broadcast-created`, regardless of which path got here:)**
  - Try `sendProLaunchBroadcast({broadcastId})`.
    - On failure: call
      `_markFinalizeFailed({runId, substatus:'send-broadcast-failed', error})`.
      Status stays `broadcast-created` for clarity — the broadcast
      object exists in Resend; only the send failed. `failureSubstatus`
      is set so operator tooling and the `resumeFinalizeWaveRun` mutation
      know to retry only the send step. Lease remains held. Exit.
    - On success: call `_finalizeWaveRun({runId, sentAt: Date.now()})`.
      Mutation atomically patches `broadcastRampConfig` (advance tier,
      `lastWave*`, `lastRunStatus='succeeded'`, clear `pendingRunId`)
      AND patches `waveRuns.status='sent'`.

**Recovery branches** (also documented in the recovery semantics section
below):

- `pushing` (stale): `resumeStalledWaveRun` → schedules `pushBatchAction`
- `broadcast-created` (send failed): operator FIRST verifies in Resend
  dashboard that the broadcast for `waveRuns.broadcastId` was NOT
  actually sent (Resend may have queued it despite the action seeing
  an error). If confirmed not-sent → `resumeFinalizeWaveRun({runId, confirmedNotSent: true})`
  → schedules `finalizeWaveAction` again, which sees `broadcast-created`
  status and skips straight to the send step using the stored `broadcastId`.
  If Resend shows already-sent → operator runs a separate
  `markFinalizeRecovered({runId, sentAt: <as_observed_in_resend>})`
  helper that calls `_finalizeWaveRun` directly without retrying the
  send. (One-shot operator command; no scheduled action needed.)
- `failed` with `failureSubstatus='create-broadcast-failed'`:
  `resumeFinalizeWaveRun` → patches status back to `pushing` (so the
  finalize logic re-enters via the create-broadcast path) and schedules
  `finalizeWaveAction`. Operator must verify the segment is still
  intact in Resend before resuming.
- `failed` with `failureSubstatus='batch-failure-rate-exceeded'`: only
  `discardWaveRun` makes sense (the underlying push failures need
  investigation/code fix; not a transient).

**Optional (deferred):** schedule cleanup of `wavePickedContacts` rows
older than 7 days for runs in `sent` status — analogous to the
`cleanupDiscardedWavePickedContactsAction` cron path. Defer to backlog.

### Wrap upstream errors

Replace every `if (!res.ok) throw new Error(...)` in the broadcast module with:

```ts
if (!res.ok) {
  const body = await res.text().catch(() => '<no body>');
  throw new Error(`[upstream:resend] ${res.status} ${res.statusText}: ${body}`);
}
```

Eliminates the opaque `Error` we saw twice this week.

### `runDailyRamp` integration

`runDailyRamp` becomes an orchestrator with explicit in-flight guard:

1. Pre-claim checks (kill-gate, tier-complete) — unchanged.
2. **NEW guard:** query `waveRuns` for any row with status in
   `{picking, segment-created, pushing, broadcast-created}`. If found,
   compute `lastActivityAt = row.lastBatchAt ?? row.updatedAt ?? row.createdAt`
   (lastBatchAt is undefined during `picking`/`segment-created` phases —
   fall back to `updatedAt` (always set), then `createdAt`).
   - If `now - lastActivityAt < 15 min` → log "wave in flight, skip" and
     return.
   - If `now - lastActivityAt >= 15 min` → log "stalled run detected,
     manual recovery required" and return without claiming. Operator
     selects the correct recovery mutation by `waveRuns.status`:
     `pushing`/`segment-created` → `resumeStalledWaveRun`;
     `broadcast-created` or `failed/send-broadcast-failed` →
     `resumeFinalizeWaveRun({confirmedNotSent: true})` after Resend
     verification, or `markFinalizeRecovered` if Resend shows already
     sent; `failed/batch-failure-rate-exceeded` → `discardWaveRun`.
3. Otherwise: schedule `pickWaveAction` via
   `ctx.scheduler.runAfter(0, internal.broadcast.waveRuns.pickWaveAction, args)`.
   **Do not** use `ctx.runAction(...)` — that awaits the entire pipeline
   and would re-introduce the 10-min budget problem inside
   `runDailyRamp`. The runtime guarantees scheduled-at-0 actions start
   in a fresh execution context, so each step gets its own budget.
4. Return immediately.

This preserves the "one wave in flight at a time" invariant of the existing
`pendingRunId` lease, surfaced via the `waveRuns` table.

### Recovery semantics (Codex r1 finding)

Two failure modes, each with explicit operator recovery:

**Stale `pushing`:** action timed out mid-flight; `lastActivityAt` is stale.

- Detection: `runDailyRamp` next tick sees `now - lastActivityAt > 15 min`
  and refuses to claim.
- Operator runs: `resumeStalledWaveRun({runId})` → patches
  `waveRuns.lastBatchAt = now()` and schedules fresh `pushBatchAction`.
  Idempotent on `(runId, normalizedEmail)` because `pushBatchAction`'s
  `_getPendingBatch` query only returns `status='pending'` rows — already-
  pushed and already-failed contacts are skipped. Re-stamping the
  registration row is also idempotent (the inlined stamp logic in
  `_markContactPushed` includes an `alreadyStamped` early-return).

**`failed`:** batch error rate exceeded 5% threshold OR Resend persistent
error.

- Operator inspects `waveRuns.error` + `wavePickedContacts` rows where
  `status='failed'` (`failedReason` field) + Resend dashboard.
- Operator decides:
  - **Soft-discard the segment:** run `discardWaveRun({runId})` → marks
    `waveRuns.status='failed'` with reason='discarded-by-operator',
    rotates `waveLabelOffset`, clears lease. The contact rows are NOT
    deleted synchronously; instead, the daily-cleanup cron action
    (`cleanupDiscardedWavePickedContactsAction`) prunes them in chunks
    of 500 over subsequent days. This avoids hitting Convex's per-mutation
    write limits on bulk deletion of up to 25k rows. Operator manually
    deletes Resend segment via dashboard if desired (or via the
    `discardWaveRunAction` future wrapper noted in scope).
  - **Retry as-is:** run `resumeStalledWaveRun({runId})` after fixing the
    underlying Resend issue. Note: this only retries `status='pending'`
    contacts. `status='failed'` contacts are NOT retried automatically;
    operator can manually flip them to `pending` via a one-off mutation
    if needed (out of plan scope; document in runbook).

### Tests

- Unit per mutation/query (mocked Resend at action layer).
- Unit: `_claimWaveRunLease` refuses when `pendingRunId` already set OR
  active `waveRuns` row exists.
- Integration: full happy path with 5000 fake contacts, 20 batches; assert
  final `broadcastRampConfig` state + `waveRuns.status='sent'`.
- Resume test: kill mid-batch (advance simulated clock past 15 min), call
  `runDailyRamp` (assert refusal), call `resumeStalledWaveRun`, assert
  recovery without duplicate stamps or Resend pushes.
- Lease conflict test: two `pickWaveAction` invocations near-simultaneously;
  second must be refused by `_claimWaveRunLease`.
- Underfill test: `requestedCount=1500` but only 200 unstamped registrations
  → assert `waveRuns.requestedCount=1500, totalCount=200, underfilled=true`,
  pipeline still proceeds to send the 200-contact wave.
- Empty pool test: zero unstamped registrations → assert refusal at
  `pickWaveAction` with explicit error (do NOT create empty segment).
- CAS idempotency test: invoke `_markContactPushed({runId, email})`
  twice for the same row; second call returns `{ok:false, reason:'not-pending'}`
  and `pushedCount` advances exactly once.
- Overlapping-action test: simulate two `pushBatchAction` invocations
  pulling the same pending batch; assert per-row CAS guards prevent double
  push counters and double registration stamps. **Acceptable behavior
  the test must NOT assert against:** duplicate Resend `upsertContactToSegment`
  calls. Two actions can both POST to Resend before either reaches the
  marking mutation. This is acceptable because Resend's
  upsert-contact-to-segment is idempotent — the existing code already
  treats the response as `created | linkedExisting | alreadyInSegment`,
  all of which are valid success outcomes (`audienceWaveExport.ts:395-405`).
  The wasted Resend API call is bounded (≤ batchSize × N overlapping
  actions, in practice 2) and is a deliberate design trade-off vs adding
  a `processing`-state reservation lease (which would add lease-timeout
  recovery surface for marginal benefit).
- Pick-phase failure tests: empty pool → `_markPickFailed('empty-pool')`,
  lease cleared, status='failed', substatus='empty-pool'. Resend
  createSegment fails → lease HELD, status='failed',
  substatus='segment-create-failed'. Persist mid-loop failure → lease
  HELD, status='failed', substatus='persist-failed'.
- Resend 5xx mid-batch test: assert backoff retries, assert `failed`
  outcome only after all retries exhausted.
- Resend 429 test: assert backoff respects retry-after header if present.

### Verification before resuming the cron

- Test fork: stage 5000 fake registrations, run `pickWaveAction` end-to-end
  with mocked Resend → assert `getRampStatus` shows live progress, final
  state correct.
- Force a kill mid-batch → run `resumeStalledWaveRun` → assert recovery
  without duplicates.
- Once green: deploy to prod, manually invoke `pickWaveAction` for wave-5
  (5000 contacts), watch progress, send broadcast.
- Resume cron via `resumeRamp` only after successful manual wave-5.

### Rollback runbook (Codex r1 finding)

If reverting PR 2 is needed (mid-deploy regression, etc.), run this sequence:

1. **Pause:** `npx convex run 'broadcast/rampRunner:pauseRamp' '{}'`
2. **Find in-flight runs:**

   ```bash
   npx convex run 'broadcast/waveRuns:_listInFlight' '{}'
   ```

   Returns runs with status in `{picking, segment-created, pushing, broadcast-created}`.
3. **For each in-flight run, decide:**
   - **Already past `pushing`** (broadcast created or sent): leave alone;
     reconcile state manually via `recoverFromPartialFailure` after revert.
   - **Mid-`pushing`**: cancel scheduled `pushBatchAction` calls. Convex
     does not expose a stable scheduler-cancel API for already-queued
     actions, so the safe path is to mark the waveRun as failed:

     ```bash
     npx convex run 'broadcast/waveRuns:_markFailed' '{"runId":"X","reason":"rollback"}'
     ```

     The next scheduled `pushBatchAction` will see `status='failed'` on
     entry and exit immediately.
   - **`picking` (no segment yet)**: same as above — mark failed; the
     in-flight action will exit on its own.
4. **Inspect Resend** for any segments/broadcasts created by partial runs;
   delete from dashboard if undesired.
5. **Revert code.**
6. **Existing post-revert recovery:** any registration stamped during the
   reverted run remains stamped; segment in Resend remains. To send the
   wave manually: use existing `recoverFromPartialFailure` machinery from
   the OLD code.
7. **Resume:** `npx convex run 'broadcast/rampRunner:resumeRamp' '{}'`.

### Acceptance criteria for PR 2

- [ ] All unit + integration tests pass
- [ ] `getRampStatus` returns batch-level progress (batchN, totalCount, pushedCount, lastBatchAt)
- [ ] Test-fork run of 5000 contacts completes without operator intervention
- [ ] Resume from forced mid-batch kill works
- [ ] Lease-conflict test shows second invocation refused
- [ ] Prod wave-5 (real send) succeeds on first invocation
- [ ] Rollback runbook validated on test fork (revert + recover end-to-end)

## PR 3 — `setPreferences` polish + `subscription.updated` handler

**Tracker:** Task #26 (blocked by Task #24)
**Estimated effort:** ~half day
**Files changed:** ~5
**Gate:** PR 1 deployed ≥24h with verified storm decay (via Sentry
`error_shape:setPreferences_conflict` distribution)

### E. `setPreferences` throw → discriminated return

**Why:** the CAS guard throw at `userPreferences.ts:71` is correct behavior
but Convex Insights flags every throw as a function failure. After PR 1
drains stale-bundle users, a small steady volume of "real concurrent edits"
remains and clutters the dashboard. Switching from throw to return
eliminates the surface entirely.

**Changes:**

1. `convex/userPreferences.ts:71` — change CONFLICT throw to:

   ```ts
   return {
     ok: false as const,
     reason: 'CONFLICT' as const,
     actualSyncVersion: existing.syncVersion,
   };
   ```

   Success branch:

   ```ts
   return { ok: true as const, syncVersion: nextSyncVersion };
   ```

   Keep `BLOB_TOO_LARGE` and `UNAUTHENTICATED` as throws (rare; want them
   in Sentry as errors).
2. `api/user-prefs.ts:128` — read result.ok:

   ```ts
   const result = await client.mutation('userPreferences:setPreferences' as any, {...});
   if (!result.ok && result.reason === 'CONFLICT') {
     // No Sentry capture (no longer a thrown error). Volume should be
     // visible in HTTP 409 access logs if needed.
     return jsonResponse(
       { error: 'CONFLICT', actualSyncVersion: result.actualSyncVersion },
       409,
       cors,
     );
   }
   return jsonResponse({ syncVersion: result.syncVersion }, 200, cors);
   ```

3. Catch block keeps `BLOB_TOO_LARGE` / `UNAUTHENTICATED` paths.
4. Remove now-dead `extractConvexErrorKind(err, msg) === 'CONFLICT'`
   branch + `readConvexErrorNumber(err, 'actualSyncVersion')` for that branch.

**Tests:**

- Existing client tests (`cloud-prefs-sync.ts`) pass unchanged (HTTP shape
  identical).
- New unit on server: stale-version returns
  `{ok:false, reason:'CONFLICT', actualSyncVersion}`.
- New unit on edge handler: `result.ok=false, reason='CONFLICT'` → 409
  response with `actualSyncVersion`.

**Verification:**

- Convex Insights `setPreferences` failure rate → 0% within 1h post-deploy.
- Sentry `error_shape:setPreferences_conflict` count → 0 (capture path
  removed; legitimate 409s no longer go through Sentry).

### F. `subscription.updated` webhook handler (paid-through-aware)

**Codex r1 finding addressed:** existing `handleSubscriptionCancelled`
preserves entitlement until `currentPeriodEnd` (paid-through). The new
`handleSubscriptionUpdated` must dispatch by incoming `status` and
respect the same paid-through invariant.

**Changes:**

1. `convex/payments/webhookMutations.ts:67` — add to allowed event list:

   ```ts
   const subscriptionEvents = [
     "subscription.active", "subscription.renewed", "subscription.on_hold",
     "subscription.cancelled", "subscription.plan_changed", "subscription.expired",
     "subscription.updated",                            // NEW
   ] as const;
   ```

2. `convex/payments/webhookMutations.ts:77` switch — add:

   ```ts
   case "subscription.updated":
     await handleSubscriptionUpdated(ctx, data, args.timestamp);
     break;
   ```

3. `convex/payments/webhookMutations.ts:108` default:
   change `console.warn` → `console.error` for events with prefix `subscription.*`
   (so unhandled future Dodo additions are Sentry-pageable).
4. `convex/payments/subscriptionHelpers.ts` — new
   `handleSubscriptionUpdated(ctx, data, eventTimestamp)`:

   ```ts
   // subscription.updated is Dodo's catch-all "any field changed"
   // event. We dispatch by the payload's `status` field so the same
   // policy applies as the dedicated lifecycle events.
   const status = (data.status ?? '').toString();
   switch (status) {
     case 'active':
       return handleSubscriptionActive(ctx, data, eventTimestamp);
     case 'on_hold':
       return handleSubscriptionOnHold(ctx, data, eventTimestamp);
     case 'cancelled':
       return handleSubscriptionCancelled(ctx, data, eventTimestamp);
     case 'expired':
       return handleSubscriptionExpired(ctx, data, eventTimestamp);
     case 'failed':
     case 'paused':
     default:
       // Unknown status — patch the row's rawPayload + updatedAt so we don't
       // lose the event, recompute entitlement defensively. Log so
       // ops can decide if a new dedicated handler is needed.
       console.error(
         `[handleSubscriptionUpdated] unhandled status="${status}" sub=${data.subscription_id}; ` +
         `recomputing entitlement defensively`,
       );
       const existing = await ctx.db
         .query('subscriptions')
         .withIndex('by_dodoSubscriptionId', (q) =>
           q.eq('dodoSubscriptionId', data.subscription_id),
         )
         .unique();
       if (existing && isNewerEvent(existing.updatedAt, eventTimestamp)) {
         await ctx.db.patch(existing._id, {
           rawPayload: data,
           updatedAt: eventTimestamp,
         });
         await recomputeEntitlementFromAllSubs(ctx, existing.userId, eventTimestamp);
       }
   }
   ```

5. Schema check: `DodoSubscriptionData` interface at `subscriptionHelpers.ts:25`
   already has `cancelled_at` etc. but `status` field is not declared.
   Add: `status?: string;` to the interface.

**Tests:**

- Unit: `subscription.updated` with `status='cancelled'` and
  `currentPeriodEnd > eventTimestamp` → entitlement preserved (paid-through;
  this delegates to `handleSubscriptionCancelled` which already implements
  this policy).
- Unit: `subscription.updated` with `status='cancelled'` and
  `currentPeriodEnd <= eventTimestamp` → entitlement downgraded.
- Unit: `subscription.updated` with `status='active'` and existing planKey
  change → entitlement re-derived to new plan.
- Unit: `subscription.updated` with `status='on_hold'` → delegates to
  `handleSubscriptionOnHold`.
- Unit: stale `eventTimestamp` (older than `existing.updatedAt`) → rejected
  via `isNewerEvent` guard inherited from delegated handlers.
- Unit: `subscription.updated` with unknown status (e.g. `'pending'`) →
  defensive recompute path runs; logs error.

**Verification:**

- Trigger Dodo sandbox subscription update; confirm handler runs and
  entitlement re-derives consistent with paid-through policy.

### Acceptance criteria for PR 3

- [ ] Convex Insights `setPreferences` failure rate = 0%
- [ ] All client tests (`cloud-prefs-sync.ts`) pass without modification
- [ ] `subscription.updated` test webhook produces correct entitlement state
      respecting paid-through cancellation policy
- [ ] Unknown-status subscription.updated event triggers defensive recompute
      AND `console.error` (Sentry-paged)

## Out of scope (deferred)

| Item | Reason | Backlog trigger |
|---|---|---|
| `processWebhookEvent` serialize per `subscription_id` | Auto-retry handles correctness; cost ≫ value | Insights shows >5% retry rate sustained |
| Documentation/runbook updates | Separate concern; do after operational fixes settle | Once PR 2 deployed for 1 week |
| `processWebhookEvent` field-narrowing optimization | Polish; not blocking | If retry rate spikes |
| Automated Resend segment deletion in `discardWaveRun` | Action wrapper requires separate Resend permission scope; defer until needed | First time operator finds manual delete tedious |

## Open questions / known unknowns

1. **Build-hash injection robustness:** confirm `VERCEL_GIT_COMMIT_SHA` is set
   on both production and preview Vercel deploys. If not on preview, the
   plugin emits `'dev'` and the staleness check skips the comparison
   (intentional — `hash !== 'dev'` guard in stale-bundle-check.ts).
2. **Tab focus on mobile Safari:** iOS fires `focus` differently when
   returning from background. Verify with manual mobile test during PR 1.
3. **`waveRuns` retention:** keep historic rows for audit, or auto-prune
   after 30 days? Default keep; revisit if table growth becomes unwieldy.
4. **Resume-on-deploy of PR 2:** if PR 2 deploys mid-`pushBatch`, the
   in-flight scheduled action survives but new code may diverge from old
   data shape. Mitigate by: deploying when no run is in flight (cron
   paused + `getRampStatus` shows no `waveRuns` in flight). Pre-deploy
   checklist item.
5. **Convex scheduler cancel API:** as noted in PR 2 rollback runbook,
   Convex doesn't expose a stable cancel-scheduled-action API. We rely on
   the in-flight action's lease-revalidation to short-circuit on
   `status='failed'`. If Convex adds a cancel API later, the rollback
   runbook can be tightened.
6. **Dodo `subscription.updated` field set:** Dodo's docs describe this as
   "real-time sync without polling" but don't enumerate what fields appear.
   Defensive recompute path covers unknown statuses; monitor Sentry for
   first occurrences post-deploy.

## Status log

- 2026-04-29 14:30 UTC — plan r1 written
- 2026-04-29 15:30 UTC — Codex review round 1 (8 findings); revised → r2
- 2026-04-29 15:45 UTC — Codex review round 2 (6 findings); revised → r3
- 2026-04-29 16:00 UTC — Codex review round 3 (5 findings); revised → r4
- 2026-04-29 16:15 UTC — Codex review round 4 (3 findings); revised → r5
- 2026-04-29 16:30 UTC — Codex review round 5 (1 finding: contradiction between `resumeStalledWaveRun` and `resumeFinalizeWaveRun` on `broadcast-created`); revised → r6
- 2026-04-29 16:45 UTC — Codex review round 6: ✅ **APPROVED** ("coherent recovery model… no remaining implementation blockers"). Applied non-blocking wording polish to the `runDailyRamp` stalled-run note enumerating which recovery mutation to use per status.
