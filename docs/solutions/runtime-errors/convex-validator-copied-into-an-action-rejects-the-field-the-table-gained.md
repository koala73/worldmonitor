---
title: A Convex validator copied into an action rejects the field the table gained
date: 2026-10-20
category: runtime-errors
module: convex-entitlements
problem_type: runtime_error
component: payments
symptoms:
  - "Sentry WORLDMONITOR-18W from Convex `payments/cacheActions:syncEntitlementCache`: ArgumentValidationError, Object contains extra field `historyDays` that is not in the validator"
  - "Fired on every entitlement write after #9435 shipped; the write itself succeeded, only the scheduled Redis cache sync failed"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
related_components: [database]
tags: [convex, validator, v-object, entitlements, redis-cache, schema-drift, sentry]
---

# A Convex validator copied into an action rejects the field the table gained

## Problem

The `entitlements` table and the internal action `syncEntitlementCache` each kept their own copy of the `features` object validator. #9435 added `historyDays` to the table's copy only. After every entitlement write, `upsertEntitlements` schedules the action with the exact `features` object it just wrote. Convex's `v.object` rejects keys the validator does not list, so every immediate cache sync failed.

## Symptoms

- Sentry WORLDMONITOR-18W (Convex source, `func: payments/cacheActions:syncEntitlementCache`):
  ``ArgumentValidationError: Object contains extra field `historyDays` that is not in the validator. Path: .features``
- Every `PRODUCT_CATALOG` plan carries `historyDays`, so the failure was not tied to one plan. A test run against each plan's features failed for all 10.
- The impact was a delay, not a lost upgrade. `upsertEntitlements` also schedules `resyncEntitlementCacheFromDb` 15 s later (`ENTITLEMENT_CACHE_RESYNC_DELAY_MS`), and that action takes only `userId`, so it wrote the cache. The gateway saw a new plan about 15 s late, and Convex logged an error for each write.

## What Didn't Work

- **Trusting the table validator as the contract.** The schema copy carried a comment saying it "MUST accept" each catalog field, because `v.object` is strict on extra keys. The action's copy had the same warning in spirit, but no test exercised the action with real catalog output, so the second copy drifted silently.

## Solution

Both sites now use one validator from `convex/lib/entitlementFeaturesValidator.ts` (#9452):

```ts
// convex/schema.ts
entitlements: defineTable({
  userId: v.string(),
  planKey: v.string(),
  features: entitlementFeaturesValidator,
  ...

// convex/payments/cacheActions.ts
export const syncEntitlementCache = internalAction({
  args: {
    userId: v.string(),
    planKey: v.string(),
    features: entitlementFeaturesValidator,
    validUntil: v.number(),
  },
```

`convex/__tests__/entitlement-cache-sync.test.ts` runs the action against `getFeaturesForPlan(planKey)` for every key in `PRODUCT_CATALOG`. It clears `UPSTASH_REDIS_REST_URL` so the handler returns before any network call, which leaves only argument validation under test. Before the fix, all 10 plans failed with ``Validator error: Unexpected field `historyDays` in object``. After the fix, all 10 pass.

After the Convex deploy, `npx convex function-spec` against production listed `historyDays` among `syncEntitlementCache`'s `features` fields.

## Why This Works

The failure was two copies of one contract. With a single validator object, a field added to the table is accepted by the action in the same edit. The test covers what a shared constant cannot: a future catalog field that neither validator lists. It fails because it feeds real catalog output through the action.

## Prevention

- **When a Convex function receives a document (or part of one) that a table validator already describes, import that validator; don't copy it.** `v.object` is strict, so any copy is a runtime rejection waiting for the next optional field.
- **Test validator acceptance with producer output, not hand-written fixtures.** Iterate the real source of values (`PRODUCT_CATALOG` here) through the consuming function. A hand-written fixture repeats whatever the author remembered.
- **When a Sentry fix depends on a deploy, check the deploy time before calling a post-merge event a regression.** Two more 18W events arrived at 08:50:41 and 08:50:45, but `convex-deploy.yml`'s "Convex deploy (prod)" step finished at 08:51:19, so both predated the fix.

## Related Issues

- #9452 (this fix), #9435 (added `historyDays`)
- `docs/solutions/logic-errors/a-proxy-that-reports-the-remote-servers-verdict-as-its-own-defect.md` for a CORS header list that drifted across three hand-kept copies in the same triage (#9453)
