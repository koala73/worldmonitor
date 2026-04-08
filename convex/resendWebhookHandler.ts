import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./lib/env";

const HANDLED_EVENTS = new Set(["email.bounced", "email.complained"]);

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
  return signatures.some((s) => {
    const [, val] = s.split(",");
    return val === expected;
  });
}

export const resendWebhookHandler = httpAction(async (ctx, request) => {
  const secret = requireEnv("RESEND_WEBHOOK_SECRET");

  const rawBody = await request.text();

  const valid = await verifySignature(rawBody, request.headers, secret);
  if (!valid) {
    console.warn("[resend-webhook] Invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let event: { type: string; data?: { to?: string[]; email_id?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    return new Response(null, { status: 200 });
  }

  const recipients = event.data?.to;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return new Response(null, { status: 200 });
  }

  const reason = event.type === "email.bounced" ? "bounce" : "complaint";

  for (const email of recipients) {
    try {
      await ctx.runMutation(internal.emailSuppressions.suppress, {
        email,
        reason: reason as "bounce" | "complaint",
        source: `resend-webhook:${event.data?.email_id ?? "unknown"}`,
      });
      console.log(`[resend-webhook] Suppressed ${email} (${reason})`);
    } catch (err) {
      console.error(`[resend-webhook] Failed to suppress ${email}:`, err);
      return new Response("Internal processing error", { status: 500 });
    }
  }

  return new Response(null, { status: 200 });
});
