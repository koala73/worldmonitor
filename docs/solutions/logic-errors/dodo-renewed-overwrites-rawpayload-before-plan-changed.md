---
title: A renewal can overwrite rawPayload with the upgraded product before plan_changed moves planKey
date: 2026-11-09
category: logic-errors
module: convex/payments
problem_type: logic_error
component: payments
symptoms:
  - "Admin plan-upgrade email shows the new price as the old price (Change +$0.00)"
  - "Monthly-to-annual upgrades show a wrong annualized difference"
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags: [dodo, webhooks, subscription-renewed, plan-changed, rawpayload, plan-precedence]
---

# A renewal can overwrite rawPayload with the upgraded product before plan_changed moves planKey

## Problem

Dodo can deliver `subscription.renewed` before `subscription.plan_changed` for the same upgrade. They share one batch timestamp (the #8733 ordering, pinned in `convex/__tests__/webhook.test.ts`). `handleSubscriptionRenewed` replaces `subscriptions.rawPayload` with the upgraded payload. It leaves `planKey` and `dodoProductId` unchanged, so the row pairs the old plan with the new plan's price.

## Symptoms

- The PR #10330 upgrade email read the "old price" from `rawPayload` and showed a $39.99 → $49.99 upgrade as $49.99 → $49.99, +$0.00.

## What Didn't Work

- Reading `previous.rawPayload.recurring_pre_tax_amount` as the price of `previous.planKey`. That holds only when the stored payload belongs to the stored plan.

## Solution

In `previousPrice()` (`convex/payments/subscriptionHelpers.ts`), use the stored payload's price only when its `product_id` matches the row's `dodoProductId`. The renewed handler never writes `dodoProductId`. Otherwise fall back to the old plan's catalog list price and label it in the email:

```ts
if (raw?.product_id === previous.dodoProductId && typeof raw.recurring_pre_tax_amount === "number") {
  return {
    oldAmount: raw.recurring_pre_tax_amount,
    oldCurrency: typeof raw.currency === "string" ? raw.currency : undefined,
  };
}
const listPrice = PRODUCT_CATALOG[previous.planKey]?.priceCents;
return typeof listPrice === "number" ? { oldAmount: listPrice, oldCurrency: "USD", oldIsListPrice: true } : {};
```

## Why This Works

`rawPayload` holds the latest event's payload. It is not a snapshot of the plan in `planKey`. `dodoProductId` changes only with `planKey` (on `plan_changed` and active `subscription.updated`), so the product match tells you whether the payload and the plan agree.

## Prevention

- Treat any `rawPayload` field as "latest event", never as "current plan", unless its `product_id` matches `dodoProductId`.
- Webhook tests that compare old and new plan state need a renewal-first case. See "a renewal carrying the new product before plan_changed does not pose as the old price" in `convex/__tests__/planUpgradeEmail.test.ts`, which failed with the symptom above before the fix.
- To rank plans (upgrade vs downgrade), compare `PLAN_PRECEDENCE`, which the entitlement recompute already uses: tier, then capability, then commitment. A tier-plus-annualized-price rule called Pro Business Annual → Pro Monthly an upgrade.

## Related Issues

- #8733: `plan_changed` sharing a batch timestamp with an earlier `renewed`.
- PR #10330: admin conversion-source and plan-upgrade emails.
