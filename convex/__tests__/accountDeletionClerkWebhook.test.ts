import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { CLERK_SKEW_SECONDS, MAX_SIGNATURE_CANDIDATES } from "../accountDeletion/clerkWebhook";

const modules = import.meta.glob("../**/*.ts");

const { dodoUpdateMock } = vi.hoisted(() => ({
  dodoUpdateMock: vi.fn(async () => ({ status: "cancelled" })),
}));

vi.mock("dodopayments", () => ({
  DodoPayments: class {
    subscriptions = { update: dodoUpdateMock };
  },
  NotFoundError: class NotFoundError extends Error {
    status = 404;
  },
  APIConnectionTimeoutError: class APIConnectionTimeoutError extends Error {
    constructor(message = "timeout") {
      super(message);
      this.name = "APIConnectionTimeoutError";
    }
  },
}));

const TEST_NOW_SECONDS = 1_700_000_000;
const TEST_NOW_MS = TEST_NOW_SECONDS * 1000;
const SECRET_BYTES = new Uint8Array([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87,
  0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f,
]);
const CLERK_WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;
const USER_ID = "user_clerk_deleted_webhook";

function deletedPayload(userId = USER_ID): string {
  return JSON.stringify({
    type: "user.deleted",
    data: { id: userId, deleted: true, object: "user" },
  });
}

function hostnameOf(urlLike: string): string | null {
  try {
    return new URL(urlLike).hostname;
  } catch {
    return null;
  }
}

function isClerkApiUrl(urlLike: string): boolean {
  return hostnameOf(urlLike) === "api.clerk.com";
}

async function signPayload(
  payload: string,
  {
    messageId = "msg_clerk_deleted",
    timestamp = String(TEST_NOW_SECONDS),
  }: { messageId?: string; timestamp?: string } = {},
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    SECRET_BYTES,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${messageId}.${timestamp}.${payload}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function postClerkWebhook(
  t: ReturnType<typeof convexTest>,
  {
    payload,
    messageId = "msg_clerk_deleted",
    timestamp = String(TEST_NOW_SECONDS),
    signature,
  }: {
    payload: string;
    messageId?: string;
    timestamp?: string;
    signature?: string;
  },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "svix-id": messageId,
    "svix-timestamp": timestamp,
  };
  if (signature !== undefined) headers["svix-signature"] = signature;
  return t.fetch("/clerk-webhook", { method: "POST", headers, body: payload });
}

describe("Clerk account-deletion webhook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.CLERK_WEBHOOK_SECRET;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DODO_API_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  test("invalid signature 401s before any erase", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const payload = deletedPayload();
    const res = await postClerkWebhook(t, {
      payload,
      signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(res.status).toBe(401);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(0);
  });

  // The skew guard is the only replay defense on an irreversible erase, and it
  // had no coverage: an inverted comparison, a wrong divisor, or a deleted
  // check would all have shipped green. Each case below signs the SAME
  // timestamp it sends, so a rejection can only come from the window check.
  test("a validly signed but stale delivery 401s before any erase", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const payload = deletedPayload();
    const timestamp = String(TEST_NOW_SECONDS - CLERK_SKEW_SECONDS - 1);
    const res = await postClerkWebhook(t, {
      payload,
      timestamp,
      signature: `v1,${await signPayload(payload, { timestamp })}`,
    });
    expect(res.status).toBe(401);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(0);
  });

  test("a validly signed delivery from the future 401s before any erase", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const payload = deletedPayload();
    const timestamp = String(TEST_NOW_SECONDS + CLERK_SKEW_SECONDS + 1);
    const res = await postClerkWebhook(t, {
      payload,
      timestamp,
      signature: `v1,${await signPayload(payload, { timestamp })}`,
    });
    expect(res.status).toBe(401);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(0);
  });

  test("a non-numeric timestamp 401s before any erase", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const payload = deletedPayload();
    const timestamp = "not-a-timestamp";
    const res = await postClerkWebhook(t, {
      payload,
      timestamp,
      signature: `v1,${await signPayload(payload, { timestamp })}`,
    });
    expect(res.status).toBe(401);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(0);
  });

  test("only a bounded number of signature candidates is considered", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const payload = deletedPayload();
    const real = await signPayload(payload);
    // The header is attacker-supplied on an unauthenticated endpoint and each
    // candidate costs a key generation plus two HMAC signs. Burying the real
    // signature past the cap must fail closed rather than make us do the work.
    const padding = Array.from(
      { length: MAX_SIGNATURE_CANDIDATES + 20 },
      (_unused, i) => `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${i}=`,
    );
    const res = await postClerkWebhook(t, {
      payload,
      signature: [...padding, `v1,${real}`].join(" "),
    });
    expect(res.status).toBe(401);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(0);
  });

  test("a real signature within the cap still verifies", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    process.env.CLERK_SECRET_KEY = "sk_test";
    process.env.DODO_API_KEY = "ddp_test";
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (isClerkApiUrl(url)) return new Response("gone", { status: 404 });
      if (url.includes("upstash.test")) return Response.json({ result: "OK" });
      return new Response("unexpected", { status: 500 });
    });
    const t = convexTest(schema, modules);
    const payload = deletedPayload();
    const real = await signPayload(payload);
    // Svix sends one signature per active signing key, so a rotation looks
    // like this -- a couple of stale candidates ahead of the live one.
    const res = await postClerkWebhook(t, {
      payload,
      signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${real}`,
    });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(1);
  });

  test("valid user.deleted starts erase and a duplicate event id is a no-op", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    process.env.CLERK_SECRET_KEY = "sk_test";
    process.env.DODO_API_KEY = "ddp_test";
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (isClerkApiUrl(url)) return new Response("gone", { status: 404 });
      if (url.includes("upstash.test")) return Response.json({ result: "OK" });
      return new Response("unexpected", { status: 500 });
    });
    const t = convexTest(schema, modules);
    await t.mutation(internal.followedCountries._seedShards, {});
    await t.mutation(internal.followedCountries._seedCountryLocks, {});
    const payload = deletedPayload();
    const signature = await signPayload(payload);
    const first = await postClerkWebhook(t, { payload, signature: `v1,${signature}` });
    expect(first.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const afterFirst = await t.run(async (ctx) =>
      ctx.db.query("accountDeletions").withIndex("by_userId", (q) => q.eq("userId", USER_ID)).unique(),
    );
    expect(afterFirst?.source).toBe("clerk_webhook");
    expect(afterFirst?.status).toBe("complete");

    const second = await postClerkWebhook(t, { payload, signature: `v1,${signature}` });
    expect(second.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(1);
    const events = await t.run(async (ctx) => ctx.db.query("webhookEvents").collect());
    expect(events).toHaveLength(1);
  });

  test("user.updated is ignored", async () => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const payload = JSON.stringify({
      type: "user.updated",
      data: { id: USER_ID },
    });
    const signature = await signPayload(payload, { messageId: "msg_updated" });
    const res = await postClerkWebhook(t, {
      payload,
      messageId: "msg_updated",
      signature: `v1,${signature}`,
    });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(0);
  });

  test("support action without userId fails", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
        userId: "",
        source: "support",
      }),
    ).rejects.toThrow("USER_ID_REQUIRED");
  });
});
