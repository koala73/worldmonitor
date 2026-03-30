import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireEnv } from "../lib/env";
import { verifyWebhookPayload } from "@dodopayments/core";

/**
 * Custom webhook HTTP action for Dodo Payments.
 *
 * Why custom instead of createDodoWebhookHandler:
 * - We need access to webhook-id header for idempotency (library doesn't expose it)
 * - We want 401 for invalid signatures (library returns 400)
 * - We control error handling and dispatch flow
 *
 * Signature verification uses @dodopayments/core's verifyWebhookPayload
 * which wraps Standard Webhooks (Svix) protocol with HMAC SHA256.
 */
export const webhookHandler = httpAction(async (ctx, request) => {
  // 1. Read webhook secret from environment
  const webhookKey = requireEnv("DODO_PAYMENTS_WEBHOOK_SECRET");

  // 2. Extract required Standard Webhooks headers
  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const webhookSignature = request.headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return new Response("Missing required webhook headers", { status: 400 });
  }

  // 3. Read raw body for signature verification
  const body = await request.text();

  // 4. Verify signature using @dodopayments/core
  let payload: Awaited<ReturnType<typeof verifyWebhookPayload>>;
  try {
    payload = await verifyWebhookPayload({
      webhookKey,
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": webhookSignature,
      },
      body,
    });
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return new Response("Invalid webhook signature", { status: 401 });
  }

  // 5. Dispatch to internal mutation for idempotent processing.
  //    Uses the validated payload directly (not a second JSON.parse) to avoid divergence.
  //    On handler failure the mutation throws, rolling back partial writes.
  //    We catch and return 500 so Dodo retries.
  try {
    const eventTimestamp = payload.timestamp
      ? payload.timestamp.getTime()
      : Date.now();

    if (!payload.timestamp) {
      console.warn("[webhook] Missing payload.timestamp — falling back to Date.now(). Out-of-order detection may be unreliable.");
    }

    await ctx.runMutation(
      internal.payments.webhookMutations.processWebhookEvent,
      {
        webhookId,
        eventType: payload.type,
        rawPayload: payload,
        timestamp: eventTimestamp,
      },
    );
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return new Response("Internal processing error", { status: 500 });
  }

  // 6. Return 200 on success (synchronous processing complete)
  return new Response(null, { status: 200 });
});
