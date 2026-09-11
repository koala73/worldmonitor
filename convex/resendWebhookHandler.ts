import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./lib/env";
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
  };
};

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

async function verifySignature(
  payload: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  const msgId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");

  if (!msgId || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const toSign = `${msgId}.${timestamp}.${payload}`;
  const secretBytes = Uint8Array.from(atob(secret.replace("whsec_", "")), (c) =>
    c.charCodeAt(0),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(toSign),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const signatures = signature.split(" ");
  for (const s of signatures) {
    const parts = s.split(",");
    if (parts.length !== 2) continue;
    const [version, val] = parts;
    if (version !== "v1" || !val) continue;
    if (await timingSafeEqualStrings(val, expected)) return true;
  }
  return false;
}

export const resendWebhookHandler = httpAction(async (ctx, request) => {
  const secret = requireEnv("RESEND_WEBHOOK_SECRET");

  const rawBody = await request.text();

  const valid = await verifySignature(rawBody, request.headers, secret);
  if (!valid) {
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
    // svix-id is guaranteed non-null here: verifySignature returns false
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
