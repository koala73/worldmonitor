import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";

/**
 * Idempotent webhook event processor.
 *
 * Receives parsed webhook data from the HTTP action handler,
 * deduplicates by webhook-id, records the event, and dispatches
 * to event-type-specific handlers.
 *
 * All handlers are stubs for now -- they will be implemented in Plan 03.
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

    // 2. Record the event
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
      // 5. On handler failure, mark event as failed and re-throw
      // so the HTTP handler returns 500 (triggering Dodo retry)
      await ctx.db.patch(eventId, {
        status: "failed",
        errorMessage:
          error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

// --- Stub handler functions (to be implemented in Plan 03) ---

async function handleSubscriptionActive(
  _ctx: MutationCtx,
  data: unknown,
  _timestamp: number,
): Promise<void> {
  console.log("TODO: implement subscription.active", data);
}

async function handleSubscriptionRenewed(
  _ctx: MutationCtx,
  data: unknown,
  _timestamp: number,
): Promise<void> {
  console.log("TODO: implement subscription.renewed", data);
}

async function handleSubscriptionOnHold(
  _ctx: MutationCtx,
  data: unknown,
  _timestamp: number,
): Promise<void> {
  console.log("TODO: implement subscription.on_hold", data);
}

async function handleSubscriptionCancelled(
  _ctx: MutationCtx,
  data: unknown,
  _timestamp: number,
): Promise<void> {
  console.log("TODO: implement subscription.cancelled", data);
}

async function handleSubscriptionPlanChanged(
  _ctx: MutationCtx,
  data: unknown,
  _timestamp: number,
): Promise<void> {
  console.log("TODO: implement subscription.plan_changed", data);
}

async function handlePaymentEvent(
  _ctx: MutationCtx,
  data: unknown,
  eventType: string,
  _timestamp: number,
): Promise<void> {
  console.log(`TODO: implement ${eventType}`, data);
}
