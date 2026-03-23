import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import {
  handleSubscriptionActive,
  handleSubscriptionRenewed,
  handleSubscriptionOnHold,
  handleSubscriptionCancelled,
  handleSubscriptionPlanChanged,
  handleSubscriptionExpired,
  handlePaymentEvent,
  handleRefundEvent,
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
      if (existing.status === "processed") {
        console.warn(`[webhook] Duplicate webhook ${args.webhookId}, already processed — skipping`);
        return;
      }
      // Previously failed — delete the stale record so we can retry cleanly
      console.warn(`[webhook] Retrying previously failed webhook ${args.webhookId}`);
      await ctx.db.delete(existing._id);
    }

    // 2. Dispatch to event-type-specific handlers.
    //    Errors propagate (throw) so Convex rolls back the entire transaction,
    //    preventing partial writes (e.g., subscription without entitlements).
    //    The HTTP handler catches thrown errors and returns 500 to trigger retries.
    const data = args.rawPayload.data;

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
        await handlePaymentEvent(ctx, data, args.eventType, args.timestamp);
        break;
      case "refund.succeeded":
      case "refund.failed":
        await handleRefundEvent(ctx, data, args.eventType, args.timestamp);
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
