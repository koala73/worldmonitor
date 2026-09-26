import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireEnv } from "../lib/env";
import { verifySvixSignature } from "../lib/svixVerify";

/**
 * Replay window for a Svix delivery. This is the only defense against
 * re-playing a validly-signed `user.deleted` against an irreversible erase,
 * so it is exported for the test that pins it rather than duplicated there.
 */
export const CLERK_SKEW_SECONDS = 300;

/**
 * Most `v1` signatures considered per delivery; re-exported from the shared
 * verifier so the test that pins the cap keeps one import site.
 */
export { MAX_SIGNATURE_CANDIDATES } from "../lib/svixVerify";

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
  const verified = await verifySvixSignature(rawBody, request.headers, secret, {
    skewSeconds: CLERK_SKEW_SECONDS,
  });
  if (!verified.ok) {
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
