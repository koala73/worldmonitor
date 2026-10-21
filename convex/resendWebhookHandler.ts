import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./lib/env";
import { verifySvixSignature } from "./lib/svixVerify";
import { BROADCAST_TRACKED_EVENT_TYPES } from "./broadcast/metrics";

const BROADCAST_TRACKED_SET: ReadonlySet<string> = new Set(
  BROADCAST_TRACKED_EVENT_TYPES,
);

type SuppressionReason = "bounce" | "complaint" | "unsubscribe";

type ResendWebhookEvent = {
  type: string;
  created_at?: string;
  data?: {
    to?: string[];
    email?: string;
    id?: string;
    email_id?: string;
    broadcast_id?: string;
    unsubscribed?: boolean;
    // Present on email.bounced. Resend documents type as Permanent,
    // Transient or Undetermined, with subtypes such as General,
    // MailboxFull or MessageTooLarge:
    // https://resend.com/docs/webhooks/emails/bounced
    // https://resend.com/docs/dashboard/emails/email-bounces
    bounce?: {
      type?: string;
      subType?: string;
      message?: string;
    };
  };
};

export type BounceClass = "hard" | "soft" | "ignore";

// Transient subtypes that describe our message rather than the mailbox.
// They are logged but never count toward recipient suppression.
const CONTENT_CAUSED_SUBTYPES: ReadonlySet<string> = new Set([
  "messagetoolarge",
  "contentrejected",
  "attachmentrejected",
]);

/**
 * Classify an email.bounced payload. Permanent (hard) bounces suppress at
 * once. Transient and Undetermined bounces count as soft-bounce strikes.
 * A payload without a bounce type keeps the pre-existing behaviour (treat
 * as permanent), because Resend documents email.bounced as a permanent
 * rejection and older payloads carried no bounce object.
 */
export function classifyBounce(
  bounce: { type?: string; subType?: string } | undefined,
): BounceClass {
  const type = bounce?.type?.trim().toLowerCase();
  if (!type || type === "permanent") return "hard";
  // Resend's bounce-types page says "Transient"; its email.bounced field
  // reference lists "Temporary" as an example value. Accept both.
  if (type === "transient" || type === "temporary" || type === "undetermined") {
    const subType = bounce?.subType?.trim().toLowerCase() ?? "";
    return CONTENT_CAUSED_SUBTYPES.has(subType) ? "ignore" : "soft";
  }
  return "hard";
}

function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) return "***";
  return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
}

function getSuppressionDetails(
  event: ResendWebhookEvent,
): { recipients: string[]; reason: SuppressionReason } | null {
  if (event.type === "email.bounced" || event.type === "email.complained") {
    const recipients = event.data?.to;
    if (!Array.isArray(recipients) || recipients.length === 0) return null;
    // Soft bounces go through recordSoftBounce instead (see handler).
    if (event.type === "email.bounced" && classifyBounce(event.data?.bounce) !== "hard") {
      return null;
    }
    return {
      recipients,
      reason: event.type === "email.bounced" ? "bounce" : "complaint",
    };
  }

  if (event.type !== "contact.updated" || event.data?.unsubscribed !== true) {
    return null;
  }
  const email = event.data.email;
  if (typeof email !== "string" || email.trim().length === 0) return null;

  // Resend reports global contact consent through contact.updated. A false
  // value must not remove or weaken any local suppression.
  return { recipients: [email], reason: "unsubscribe" };
}

function recipientsOf(event: ResendWebhookEvent): string[] {
  const to = event.data?.to;
  if (!Array.isArray(to)) return [];
  return to.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
}

/**
 * Soft-bounce strikes and their reset. Returns a Response when the event was
 * fully handled here (or failed and must be retried), otherwise null so the
 * hard-suppression path runs. Policy and threshold live next to
 * SOFT_BOUNCE_SUPPRESS_THRESHOLD in convex/emailSuppressions.ts.
 */
async function handleSoftBounceOrDelivery(
  ctx: ActionCtx,
  event: ResendWebhookEvent,
): Promise<Response | null> {
  if (event.type === "email.delivered") {
    const deliveredAt = event.created_at
      ? Date.parse(event.created_at) || Date.now()
      : Date.now();
    for (const email of recipientsOf(event)) {
      try {
        await ctx.runMutation(internal.emailSuppressions.clearSoftBounces, { email, deliveredAt });
      } catch {
        console.error(`[resend-webhook] Failed to clear soft bounces for ${maskEmail(email)}`);
        return new Response("Internal processing error", { status: 500 });
      }
    }
    return new Response(null, { status: 200 });
  }

  if (event.type !== "email.bounced") return null;
  const bounceClass = classifyBounce(event.data?.bounce);
  if (bounceClass === "hard") return null;

  const subType = event.data?.bounce?.subType;
  if (bounceClass === "ignore") {
    console.log(`[resend-webhook] Content-caused soft bounce (${subType}); not counted`);
    return new Response(null, { status: 200 });
  }

  const emailMessageId = event.data?.email_id ?? event.data?.id;
  if (!emailMessageId) {
    console.warn("[resend-webhook] Soft bounce without email_id; not counted");
    return new Response(null, { status: 200 });
  }
  const occurredAt = event.created_at
    ? Date.parse(event.created_at) || Date.now()
    : Date.now();

  for (const email of recipientsOf(event)) {
    try {
      const result = await ctx.runMutation(internal.emailSuppressions.recordSoftBounce, {
        email,
        emailMessageId,
        bounceType: event.data?.bounce?.type ?? "unknown",
        bounceSubType: subType,
        occurredAt,
        source: `resend-webhook:${emailMessageId}`,
      });
      console.log(
        `[resend-webhook] Soft bounce ${maskEmail(email)} (${subType ?? "unknown"}): `
        + `${result.ignored ? "ignored (stale, duplicate or already suppressed)" : result.suppressed ? "suppressed" : `strike ${result.strikes}`}`,
      );
    } catch {
      console.error(`[resend-webhook] Failed to record soft bounce for ${maskEmail(email)}`);
      return new Response("Internal processing error", { status: 500 });
    }
  }
  return new Response(null, { status: 200 });
}

export const resendWebhookHandler = httpAction(async (ctx, request) => {
  const secret = requireEnv("RESEND_WEBHOOK_SECRET");

  const rawBody = await request.text();

  const verified = await verifySvixSignature(rawBody, request.headers, secret);
  if (!verified.ok) {
    // A secret we cannot decode is our misconfiguration, not a bad delivery:
    // throw so Convex answers 500 and reports it, and Svix keeps retrying.
    if (verified.reason === "malformed_secret") {
      throw new Error("[resend-webhook] RESEND_WEBHOOK_SECRET is not a valid whsec_ secret");
    }
    console.warn("[resend-webhook] Invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Broadcast metrics — record any tracked event tagged with a
  // `broadcast_id` into `broadcastEvents` for canary kill-gate decisions.
  // Idempotent on svix-id (Resend retries on 5xx and we MUST treat each
  // delivery as at-most-once).
  const broadcastId = event.data?.broadcast_id;
  if (broadcastId && BROADCAST_TRACKED_SET.has(event.type)) {
    // svix-id is guaranteed non-null here: verifySvixSignature fails
    // (and we 401'd above) if any of svix-id / svix-timestamp /
    // svix-signature were absent. Non-null assert rather than re-guard.
    const svixId = request.headers.get("svix-id") as string;
    const occurredAt = event.created_at
      ? Date.parse(event.created_at) || Date.now()
      : Date.now();
    // Let mutation throws propagate as 5xx so Resend retries. The
    // earlier `try/catch + 200` here silently dropped 53 of 250 canary
    // delivered events when an OCC contention bug threw inside the
    // mutation — Resend saw success and never retried, and the per-event
    // log row was lost with the failed mutation. Sentry caught the
    // throws (issue WORLDMONITOR-PA, 54 events) but operationally we
    // were blind. Now: throw → 5xx → Resend retries → eventual
    // consistency on the event log.
    //
    // Intentionally NOT forwarding event.data — it includes recipient
    // emails (`to: string[]`), `from`, `subject`, etc. Identifier
    // metadata above is enough; deeper inspection via emailMessageId in
    // the Resend dashboard.
    await ctx.runMutation(internal.broadcast.metrics.recordBroadcastEvent, {
      webhookEventId: svixId,
      broadcastId,
      emailMessageId: event.data?.email_id,
      eventType: event.type,
      occurredAt,
    });
  }

  const softBounceResponse = await handleSoftBounceOrDelivery(ctx, event);
  if (softBounceResponse) return softBounceResponse;

  const suppression = getSuppressionDetails(event);
  if (!suppression) {
    return new Response(null, { status: 200 });
  }

  for (const email of suppression.recipients) {
    try {
      await ctx.runMutation(internal.emailSuppressions.suppress, {
        email,
        reason: suppression.reason,
        source: `resend-webhook:${event.data?.email_id ?? event.data?.id ?? "unknown"}`,
      });
      console.log(`[resend-webhook] Suppressed ${maskEmail(email)} (${suppression.reason})`);
    } catch {
      console.error(`[resend-webhook] Failed to suppress ${maskEmail(email)}`);
      return new Response("Internal processing error", { status: 500 });
    }
  }

  return new Response(null, { status: 200 });
});
