import { httpAction, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { requireEnv } from "../lib/env";
import {
  WebhookPayloadSchema,
  type WebhookPayload,
} from "@dodopayments/core";

const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(a)),
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i]! ^ bArr[i]!;
  return diff === 0;
}

/**
 * Signature-only half of the SDK's verifyWebhookPayload, same vendored
 * standardwebhooks scheme: `whsec_` base64 secret, HMAC-SHA256 over
 * `${webhookId}.${timestamp}.${body}`, space-separated `v1,` signatures,
 * ±5 minute timestamp tolerance. Split out so a payload that authenticates
 * but fails to parse or validate is handled as a provider-side defect
 * (dead-letter + 500) instead of being mislabeled as a signature failure
 * (401). Throws Error with the SDK's message on any verification failure.
 */
async function verifyDodoSignature(
  webhookKey: string,
  webhookId: string,
  webhookTimestamp: string,
  webhookSignature: string,
  body: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const timestamp = Number.parseInt(webhookTimestamp, 10);
  if (Number.isNaN(timestamp)) {
    throw new Error("Invalid Signature Headers");
  }
  if (now - timestamp > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error("Message timestamp too old");
  }
  if (timestamp > now + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error("Message timestamp too new");
  }

  const secretBytes = Uint8Array.from(
    atob(webhookKey.replace("whsec_", "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(computed)));

  for (const versionedSignature of webhookSignature.split(" ")) {
    const [version, signature] = versionedSignature.split(",");
    if (version !== "v1" || !signature) continue;
    if (await timingSafeEqualStrings(signature, expected)) return;
  }
  throw new Error("No matching signature found");
}

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
 * Signature verification mirrors @dodopayments/core's vendored
 * standardwebhooks scheme (HMAC SHA256), split from payload validation so
 * authenticated-but-malformed deliveries dead-letter instead of 401.
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

  // Shared failure persistence: record the sanitized projection, then queue
  // the production ops signal after the row commits. Both the validation
  // catch (step 5) and the processing catch (step 6) use it; a degraded
  // failure write never changes the provider-facing 500.
  const persistFailureAndSignal = async (failure: {
    eventType: string;
    rawPayload: unknown;
    timestamp: number;
    errorKind: string;
    errorMessage: string;
  }): Promise<void> => {
    try {
      const signal = await ctx.runMutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        {
          webhookId,
          eventType: failure.eventType,
          rawPayload: failure.rawPayload,
          timestamp: failure.timestamp,
          receivedAt: Date.now(),
          errorKind: failure.errorKind,
          errorMessage: failure.errorMessage,
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
              eventType: failure.eventType,
              errorKind: signal.errorKind,
              errorMessage: signal.errorMessage,
              attemptCount: signal.attemptCount,
              unresolvedCount: signal.unresolvedCount,
              eventTypes: signal.eventTypes,
            },
          );
        } catch (scheduleErr) {
          // sentry-coverage-ok: the caller's own console.error still reaches
          // Convex auto-Sentry; a scheduler hiccup is best-effort and must
          // not change the provider-facing 500.
          console.error("[webhook] reportDodoWebhookFailure schedule failed:", scheduleErr);
        }
      }
    } catch (recordErr) {
      // sentry-coverage-ok: the caller's own console.error still reaches
      // Convex auto-Sentry. The retry contract is more important than the
      // observability bonus — keep returning 500 if the failure write is
      // degraded.
      console.error("[webhook] Failed to persist Dodo webhook failure:", recordErr);
    }
  };

  // 4. Verify the signature on its own, BEFORE parsing. 401 is reserved for
  //    credentials that do not verify — see step 5 for authenticated but
  //    malformed payloads.
  try {
    await verifyDodoSignature(
      webhookKey,
      webhookId,
      webhookTimestamp,
      webhookSignature,
      body,
    );
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

  // 5. Parse + schema-validate the authenticated payload (the same schema
  //    the SDK's verifyWebhookPayload applies after its signature check).
  //    A failure here is a permanent provider-side defect, not a credentials
  //    failure: dead-letter a sanitized projection and return 500 so the
  //    retry exhausts into a repairable incident instead of a mislabeled 401.
  let parsedBody: unknown = null;
  let payload: WebhookPayload;
  try {
    parsedBody = JSON.parse(body);
    payload = WebhookPayloadSchema.parse(parsedBody);
  } catch (error) {
    const errorKind = error instanceof Error && error.name
      ? error.name
      : "WebhookPayloadValidationError";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const parsedRecord =
      parsedBody !== null && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? (parsedBody as Record<string, unknown>)
        : null;
    await persistFailureAndSignal({
      eventType: typeof parsedRecord?.type === "string" ? parsedRecord.type : "unknown",
      // Never the raw body text: only the parsed structure's identifiers and
      // shape keys are extracted downstream; unparseable bodies record null.
      rawPayload: parsedBody,
      timestamp: Date.now(),
      errorKind,
      errorMessage,
    });
    // sentry-coverage-ok: failure details are persisted above and the
    // scheduled report mutation provides the structured Sentry signal.
    console.error("Webhook payload validation failed:", error);
    return new Response("Invalid webhook payload", { status: 500 });
  }

  // 6. Dispatch to internal mutation for idempotent processing.
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

    await persistFailureAndSignal({
      eventType,
      rawPayload: sanitizedPayload,
      timestamp: eventTimestamp,
      errorKind,
      errorMessage,
    });

    // sentry-coverage-ok: failure details are persisted above and the
    // scheduled report mutation provides the structured Sentry signal.
    console.error("Webhook processing failed:", error);
    return new Response("Internal processing error", { status: 500 });
  }

  // 7. Recovery is deliberately outside the processing-failure catch. If this
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

  // 8. Return 200 on success (synchronous processing complete)
  return new Response(null, { status: 200 });
});
