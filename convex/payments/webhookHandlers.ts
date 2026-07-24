import { httpAction, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { requireEnv } from "../lib/env";
import { verifyWebhookPayload } from "@dodopayments/core";

/**
 * Surfaces a Dodo webhook signature failure to Convex auto-Sentry by
 * throwing a structured error. Called via `ctx.scheduler.runAfter(0,...)`
 * from the signature-failure catch path so:
 *   - the HTTP response (401) is sent immediately, unaffected
 *   - the scheduled throw runs after the response and is captured by
 *     Convex's automatic Sentry integration
 *   - no SDK install is required in the Convex backend
 *
 * Why `internalMutation` and not `internalAction`: Convex auto-retries
 * failed actions per its scheduler retry policy, which would produce N
 * duplicate Sentry events per signature failure during outages.
 * Mutations are NOT auto-retried — exactly one Sentry event per failed
 * signature check. Don't "simplify" this to an action.
 *
 * Without this, a botched secret rotation could 401 every Dodo webhook
 * silently for hours — same observability gap shape as the canary OCC
 * bug (WORLDMONITOR-PA), just on a different surface.
 */
export const reportDodoSignatureFailure = internalMutation({
  args: {
    webhookId: v.optional(v.string()),
    webhookTimestamp: v.optional(v.string()),
    errorMessage: v.string(),
  },
  handler: async (_ctx, { webhookId, webhookTimestamp, errorMessage }) => {
    throw new Error(
      `[webhook] Dodo signature verification failed (webhookId=${webhookId ?? "<missing>"}, ts=${webhookTimestamp ?? "<missing>"}): ${errorMessage}`,
    );
  },
});

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
    // sentry-coverage-ok: the scheduled mutation below throws a
    // structured error that Convex auto-Sentry captures. Required because
    // we MUST 401 (not 500) to Dodo here — re-throwing would trigger a
    // retry-storm. See scripts/check-sentry-coverage.mjs for the marker.
    console.error("Webhook signature verification failed:", error);
    // Surface to Sentry via a scheduled mutation throw — runs AFTER the
    // 401 response so Dodo's contract is preserved. Convex auto-Sentry
    // catches the throw and reports the signature failure as an issue.
    //
    // Wrapped in its own try/catch: a scheduler infrastructure hiccup
    // here MUST NOT block the 401 path. Without this guard, a thrown
    // `runAfter` would surface as an uncaught 500 to Dodo, triggering
    // exactly the retry-storm this whole pattern exists to prevent.
    try {
      await ctx.scheduler.runAfter(
        0,
        internal.payments.webhookHandlers.reportDodoSignatureFailure,
        {
          webhookId: webhookId ?? undefined,
          webhookTimestamp: webhookTimestamp ?? undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      );
    } catch (scheduleErr) {
      // Best-effort — log and continue. The 401 below is the
      // contract-critical path; Sentry capture is the bonus.
      console.error(
        "[webhook] reportDodoSignatureFailure schedule failed:",
        scheduleErr,
      );
    }
    return new Response("Invalid webhook signature", { status: 401 });
  }

  // 5. Dispatch to internal mutation for idempotent processing.
  //    Uses the validated payload directly (not a second JSON.parse) to avoid divergence.
  //    On handler failure the mutation throws, rolling back partial writes.
  //    We record a sanitized failure projection in a separate mutation before
  //    returning 500 so Dodo retries without losing the repair context.
  const eventTimestamp = payload.timestamp
    ? payload.timestamp.getTime()
    : Date.now();

  if (!payload.timestamp) {
    console.warn("[webhook] Missing payload.timestamp — falling back to Date.now(). Out-of-order detection may be unreliable.");
  }

  // Round-trip through JSON to convert Date objects to ISO strings.
  // Convex does not support Date as a value type, and the Dodo SDK
  // parses date fields (created_at, expires_at, etc.) into Date objects.
  const sanitizedPayload = JSON.parse(JSON.stringify(payload));
  const eventType = typeof payload.type === "string" ? payload.type : "unknown";

  try {
    await ctx.runMutation(
      internal.payments.webhookMutations.processWebhookEvent,
      {
        webhookId,
        eventType,
        rawPayload: sanitizedPayload,
        timestamp: eventTimestamp,
      },
    );
  } catch (error) {
    const errorKind = error instanceof Error && error.name
      ? error.name
      : "WebhookProcessingError";
    const errorMessage = error instanceof Error ? error.message : String(error);

    try {
      const signal = await ctx.runMutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        {
          webhookId,
          eventType,
          rawPayload: sanitizedPayload,
          timestamp: eventTimestamp,
          receivedAt: Date.now(),
          errorKind,
          errorMessage,
        },
      );

      // `convex-test` cannot safely await a scheduler write started by an HTTP
      // action, so keep this test-only guard aligned with the existing Redis
      // scheduler guards in subscriptionHelpers.ts. Production attempts to
      // queue the structured auto-Sentry signal after the failure row commits;
      // a scheduler failure is logged and does not alter the provider-facing
      // retry response.
      if (process.env.NODE_ENV !== "test") {
        // sentry-coverage-ok: the scheduled mutation emits a structured
        // console.error after the failure row commits, so Convex auto-Sentry
        // receives an ops signal without changing the provider-facing 500.
        try {
          await ctx.scheduler.runAfter(
            0,
            internal.payments.webhookMutations.reportDodoWebhookFailure,
            {
              webhookId,
              eventType,
              errorKind: signal.errorKind,
              errorMessage: signal.errorMessage,
              attemptCount: signal.attemptCount,
              unresolvedCount: signal.unresolvedCount,
              eventTypes: signal.eventTypes,
            },
          );
        } catch (scheduleErr) {
          console.error("[webhook] reportDodoWebhookFailure schedule failed:", scheduleErr);
        }
      }
    } catch (recordErr) {
      // The retry contract is still more important than the observability
      // bonus. Keep returning 500 if the separate failure write is degraded.
      console.error("[webhook] Failed to persist Dodo webhook failure:", recordErr);
    }

    // sentry-coverage-ok: failure details are persisted above and the
    // scheduled report mutation provides the structured Sentry signal.
    console.error("Webhook processing failed:", error);
    return new Response("Internal processing error", { status: 500 });
  }

  // Recovery is deliberately outside the processing-failure catch. If this
  // bookkeeping mutation is transiently unavailable, the provider should
  // retry the delivery, but that recovery error must not be recorded as a
  // new processing incident after billing state already committed.
  try {
    await ctx.runMutation(
      internal.payments.webhookMutations.markWebhookFailureRecovered,
      { webhookId },
    );
  } catch (error) {
    console.error("[webhook] Failed to mark Dodo webhook failure recovered:", error);
    return new Response("Internal processing error", { status: 500 });
  }

  // 6. Return 200 on success (synchronous processing complete)
  return new Response(null, { status: 200 });
});
