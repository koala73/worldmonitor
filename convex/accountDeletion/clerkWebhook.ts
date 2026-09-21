import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireEnv } from "../lib/env";

const CLERK_SKEW_SECONDS = 300;

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

async function verifyClerkSvixSignature(
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
  if (Math.abs(Date.now() / 1000 - ts) > CLERK_SKEW_SECONDS) return false;

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
  for (const part of signature.split(" ")) {
    const [version, val] = part.split(",");
    if (version !== "v1" || !val) continue;
    if (await timingSafeEqualStrings(val, expected)) return true;
  }
  return false;
}

function readClerkUserId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function readClerkType(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

export const clerkWebhookHandler = httpAction(async (ctx, request) => {
  const secret = requireEnv("CLERK_WEBHOOK_SECRET");
  const rawBody = await request.text();
  const valid = await verifyClerkSvixSignature(rawBody, request.headers, secret);
  if (!valid) {
    console.warn("[clerk-webhook] Invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const type = readClerkType(event);
  if (type !== "user.deleted") {
    return new Response("OK", { status: 200 });
  }

  const userId = readClerkUserId(event);
  if (!userId) {
    return new Response("Missing user id", { status: 400 });
  }

  const svixId = request.headers.get("svix-id");
  if (!svixId) {
    return new Response("Invalid signature", { status: 401 });
  }

  await ctx.runMutation(internal.accountDeletion.erase.ingestClerkUserDeleted, {
    webhookId: `clerk:${svixId}`,
    userId,
  });
  return new Response("OK", { status: 200 });
});
