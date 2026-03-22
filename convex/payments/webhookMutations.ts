import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import {
  handleSubscriptionActive,
  handleSubscriptionRenewed,
  handleSubscriptionOnHold,
  handleSubscriptionCancelled,
  handleSubscriptionPlanChanged,
  handlePaymentEvent,
} from "./subscriptionHelpers";

/**
 * Idempotent webhook event processor.
 *
 * Receives parsed webhook data from the HTTP action handler,
 * deduplicates by webhook-id, records the event, and dispatches
 * to event-type-specific handlers from subscriptionHelpers.
 *
 * On handler failure, the event is recorded with status "failed"
 * and the error is returned (not thrown) so the audit row persists.
 * The HTTP handler uses the returned error to send a 500 response,
 * which triggers Dodo's retry mechanism.
 */
export const processWebhookEvent = internalMutation({
  args: {
    webhookId: v.string(),
    eventType: v.string(),
    rawPayload: v.any(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. Idempotency check: skip if webhook-id already processed
    const existing = await ctx.db
      .query("webhookEvents")
      .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
      .first();

    if (existing) {
      console.log(`Duplicate webhook ${args.webhookId}, skipping`);
      return;
    }

    // 2. Record the event (persists even if handler fails)
    const eventId = await ctx.db.insert("webhookEvents", {
      webhookId: args.webhookId,
      eventType: args.eventType,
      rawPayload: args.rawPayload,
      processedAt: Date.now(),
      status: "processed",
    });

    // 3. Dispatch to event-type-specific handlers
    const data = args.rawPayload.data;

    try {
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
        case "payment.succeeded":
          await handlePaymentEvent(
            ctx,
            data,
            args.eventType,
            args.timestamp,
          );
          break;
        case "payment.failed":
          await handlePaymentEvent(
            ctx,
            data,
            args.eventType,
            args.timestamp,
          );
          break;
        default:
          console.log(`Unhandled event type: ${args.eventType}`);
      }
    } catch (error) {
      // Mark event as failed without rethrowing — this keeps the audit row
      // durable (rethrow would roll back the entire transaction).
      // The HTTP handler inspects the return value and sends 500 on error.
      await ctx.db.patch(eventId, {
        status: "failed",
        errorMessage:
          error instanceof Error ? error.message : String(error),
      });
      return {
        error: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
