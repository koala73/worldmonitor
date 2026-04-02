import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import {
  handleSubscriptionActive,
  handleSubscriptionRenewed,
  handleSubscriptionOnHold,
  handleSubscriptionCancelled,
  handleSubscriptionPlanChanged,
  handleSubscriptionExpired,
  handlePaymentOrRefundEvent,
  handleDisputeEvent,
} from "./subscriptionHelpers";

/**
 * Idempotent webhook event processor.
 *
 * Receives parsed webhook data from the HTTP action handler,
 * deduplicates by webhook-id, records the event, and dispatches
 * to event-type-specific handlers from subscriptionHelpers.
 *
 * On handler failure, the error is returned (not thrown) so Convex
 * rolls back the transaction. The HTTP handler uses the returned
 * error to send a 500 response, which triggers Dodo's retry mechanism.
 */
export const processWebhookEvent = internalMutation({
  args: {
    webhookId: v.string(),
    eventType: v.string(),
    rawPayload: v.any(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. Idempotency check: skip only if already successfully processed.
    //    Failed events are deleted so the retry can re-process cleanly.
    const existing = await ctx.db
      .query("webhookEvents")
      .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
      .first();

    if (existing) {
      // Records are only inserted after successful processing (see step 3 below).
      // If the handler throws, Convex rolls back the transaction and no record
      // is written. So `existing` always has status "processed" — it's a true
      // duplicate we can safely skip.
      console.warn(`[webhook] Duplicate webhook ${args.webhookId}, already processed — skipping`);
      return;
    }

    // 2. Dispatch to event-type-specific handlers.
    //    Errors propagate (throw) so Convex rolls back the entire transaction,
    //    preventing partial writes (e.g., subscription without entitlements).
    //    The HTTP handler catches thrown errors and returns 500 to trigger retries.
    const data = args.rawPayload.data;

    // Minimum shape guard — throw so Convex rolls back and returns 500,
    // causing Dodo to retry instead of silently dropping the event.
    // Note: permanent schema mismatches will exhaust Dodo's retry budget
    // without a durable "failed" record. Acceptable for now — Dodo caps
    // retries, and losing events silently is worse than bounded retries.
    if (!data || typeof data !== 'object') {
      throw new Error(
        `[webhook] rawPayload.data is missing or not an object (eventType=${args.eventType}, webhookId=${args.webhookId})`,
      );
    }

    const subscriptionEvents = [
      "subscription.active", "subscription.renewed", "subscription.on_hold",
      "subscription.cancelled", "subscription.plan_changed", "subscription.expired",
    ] as const;

    if (subscriptionEvents.includes(args.eventType as typeof subscriptionEvents[number]) && !(data as Record<string, unknown>).subscription_id) {
      throw new Error(
        `[webhook] Missing subscription_id for subscription event (eventType=${args.eventType}, webhookId=${args.webhookId}, dataKeys=${Object.keys(data as object).join(",")})`,
      );
    }

    switch (args.eventType) {
      case "subscription.active":
        await handleSubscriptionActive(ctx, data, args.timestamp);
        break;
      case "subscription.renewed":
        await handleSubscriptionRenewed(ctx, data, args.timestamp);
        break;
      case "subscription.on_hold":
        await handleSubscriptionOnHold(ctx, data, args.timestamp);
        break;
      case "subscription.cancelled":
        await handleSubscriptionCancelled(ctx, data, args.timestamp);
        break;
      case "subscription.plan_changed":
        await handleSubscriptionPlanChanged(ctx, data, args.timestamp);
        break;
      case "subscription.expired":
        await handleSubscriptionExpired(ctx, data, args.timestamp);
        break;
      case "payment.succeeded":
      case "payment.failed":
      case "refund.succeeded":
      case "refund.failed":
        await handlePaymentOrRefundEvent(ctx, data, args.eventType, args.timestamp);
        break;
      case "dispute.opened":
      case "dispute.won":
      case "dispute.lost":
      case "dispute.closed":
        await handleDisputeEvent(ctx, data, args.eventType, args.timestamp);
        break;
      default:
        console.warn(`[webhook] Unhandled event type: ${args.eventType}`);
    }

    // 3. Record the event AFTER successful processing.
    //    If the handler threw, we never reach here — the transaction rolls back
    //    and Dodo retries. Only successful events are recorded for idempotency.
    await ctx.db.insert("webhookEvents", {
      webhookId: args.webhookId,
      eventType: args.eventType,
      rawPayload: args.rawPayload,
      processedAt: Date.now(),
      status: "processed",
    });
  },
});
