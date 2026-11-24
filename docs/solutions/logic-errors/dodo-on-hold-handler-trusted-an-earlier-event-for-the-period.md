---
title: The on_hold handler relied on an earlier event to move the period, so an out-of-order hold lost its 7-day grace
date: 2026-11-24
category: logic-errors
module: convex/payments
problem_type: logic_error
component: payments
symptoms:
  - "A failed renewal processed on_hold-first lost paid access at once instead of 7 days later"
  - "The on-hold row stopped blocking a second checkout while Dodo kept retrying the card"
  - "The day-0 dunning email said paid access had already ended"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [dodo, webhooks, on-hold, failed-renewal, isnewerevent, out-of-order, snapshot]
---

# The on_hold handler relied on an earlier event to move the period, so an out-of-order hold lost its 7-day grace

## Problem

`handleSubscriptionOnHold` in `convex/payments/subscriptionHelpers.ts` patched only the status. It relied on an earlier webhook having already moved the row to the unpaid period. When the hold was processed first, the failed-renewal grace check read charges from the old period start. That period had been paid, so no grace was stamped. The older period-advancing event then arrived and `isNewerEvent` dropped it as stale. Fixed in PR #11219, which closes #11207.

## Symptoms

- Access ended at the old `currentPeriodEnd`, which is the failed renewal's boundary, so it ended at once.
- `isCoveringAt` was false for the row, so the customer could buy a second subscription while Dodo retried the first. A successful retry would charge them twice.
- The day-0 email took the ended-period path.
- Production had one instance, subscription `…7l4Wd7`, which went on hold on 2026-08-07. Its row kept the paid July period while its hold payload named the August period.

## What Didn't Work

- **The issue's premise that Dodo sends `subscription.renewed` before the hold.** Measured from production `webhookEvents` (2026-08-14 to 2026-11-24), a failed renewal sends no `renewed` at all. All 153 holds followed one sequence:
  1. `subscription.updated(active)` arrives twice with one timestamp and moves the period to the unpaid month.
  2. `payment.failed`.
  3. `subscription.on_hold` and `subscription.updated(on_hold)` arrive with one shared timestamp.

  So in practice "Case 1" is `on_hold` processed before `updated(active)`.
- **The issue's suggested tie rule.** It proposed accepting an equal timestamp whenever the status differs. That would let a same-timestamp `active` processed after a hold undo the hold.
- **A check of active rows whose `rawPayload.status` is `on_hold`.** It cannot find a dropped hold, because a dropped hold never writes `rawPayload`. Compare the latest event in `webhookEvents` with the row's status instead.
- **Re-deciding the grace whenever the period end moves.** A reviewer suggested this. Every hold already open in production predates the grace stamp, and #11212 deliberately left those holds on `currentPeriodEnd`. Re-deciding their grace would cut them to hold time plus 7 days after the fact.

## Solution

In `handleSubscriptionOnHold`:

1. Read the period from the hold's own payload, and fall back to the stored values when a date is missing. A missing date must not fall back to the event time, as `toEpochMs` would.

   ```ts
   const currentPeriodStart = payloadEpochMs(data.previous_billing_date) ?? existing.currentPeriodStart;
   const currentPeriodEnd = payloadEpochMs(data.next_billing_date) ?? existing.currentPeriodEnd;
   ```

2. Decide the grace on entry into the hold, and again only when the period start moves, anchored at the original `onHoldAt`. Repeat holds for the same period, one per failed retry, cannot extend or reset it.
3. If a repeat hold moves only `next_billing_date` later on an unpaid hold from before stamping, stamp the end it already had. A paid period still follows Dodo's date.
4. Let a hold win a timestamp tie only against an `active` row:

   ```ts
   const tiedHoldEntry = existing.status === "active" && eventTimestamp === existing.updatedAt;
   if (!isNewerEvent(existing.updatedAt, eventTimestamp) && !tiedHoldEntry) return;
   ```

   The `active` and `renewed` handlers stay strict. A same-timestamp `active` therefore cannot undo the hold, and a cancelled or expired row keeps its status.

## Why This Works

Every Dodo `subscription.*` payload is a full snapshot. In 143 of 144 on-hold rows, `currentPeriodStart` equals the hold payload's `previous_billing_date`, so the hold already names the failed period. A handler that applies its own snapshot gives the same result in any processing order.

Events that share a timestamp are the same snapshot. In 1754 same-timestamp groups, none disagreed on status, billing dates or product. So the strict `isNewerEvent` drop loses nothing once each handler applies the full payload. The tie rule only covers the issue's Case 2 as written, and production data shows that case did not occur.

## Prevention

- A webhook handler must apply the snapshot it carries, not rely on an earlier event having set some fields. The renewal-reconcile path in `convex/payments/billing.ts` already took the period from Dodo's response, and the hold handler now matches it.
- Before designing around a vendor's event order, measure it. Export `CONVEX_DEPLOY_KEY`, then run `npx convex data webhookEvents --limit 8000 --format jsonLines` from a worktree. A limit of 100000 crashed the CLI. Group the rows by `rawPayload.data.subscription_id` and `rawPayload.timestamp`. The guard compares `payload.timestamp` in milliseconds (`convex/payments/webhookHandlers.ts`), so grouping on that string is the same comparison.
- Test failed renewals in every arrival order. See `failed-renewal webhooks in any order` in `convex/__tests__/onhold-access-grace.test.ts`. It covers production's order, hold before `updated(active)`, hold before a late `renewed`, both tie orders, a tie with a cancellation, the stale unstamped legacy hold, and a payload without dates.
- In those tests, deliver the day-0 email at hold time before any checkout check. `checkoutBlocker` moves the fake clock forward, and an email sent afterwards correctly says access has ended.

## Related Issues

- #11207: the out-of-order reports (Case 1 and Case 2).
- PR #11212: the 7-day failed-renewal grace (`accessEndsAt`).
- PR #11219: this fix.
- #8733: same-timestamp batches and the strict `isNewerEvent` guard.
- `docs/solutions/logic-errors/dodo-renewed-overwrites-rawpayload-before-plan-changed.md` covers a sibling case, where a handler trusted a field another event had set.
