import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const TEST_NOW_SECONDS = 1_700_000_000;
const TEST_NOW_MS = TEST_NOW_SECONDS * 1000;
const SECRET_BYTES = new Uint8Array([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87,
  0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f,
]);
const RESEND_WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;

function makePayload(): string {
  return JSON.stringify({
    type: "email.opened",
    created_at: "2023-11-14T22:13:20.000Z",
    data: { email_id: "email_test_resend_signature" },
  });
}

async function signPayload(
  payload: string,
  {
    messageId = "msg_test_resend_signature",
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
  const toSign = `${messageId}.${timestamp}.${payload}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(toSign),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function replaceFirstBase64Char(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

async function postResendWebhook(
  svixSignature: string | undefined,
  {
    payload = makePayload(),
    messageId = "msg_test_resend_signature",
    timestamp = String(TEST_NOW_SECONDS),
  }: { payload?: string; messageId?: string; timestamp?: string } = {},
) {
  const t = convexTest(schema, modules);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "svix-id": messageId,
    "svix-timestamp": timestamp,
  };
  if (svixSignature !== undefined) {
    headers["svix-signature"] = svixSignature;
  }

  return await t.fetch("/resend-webhook", {
    method: "POST",
    headers,
    body: payload,
  });
}

describe("Resend webhook signature verification (#4678)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  test("accepts a valid Svix/Resend signature", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = makePayload();
    const signature = await signPayload(payload);

    const res = await postResendWebhook(`v1,${signature}`, { payload });

    expect(res.status).toBe(200);
  });

  test("rejects an invalid same-length signature", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = makePayload();
    const signature = await signPayload(payload);
    const invalidSignature = replaceFirstBase64Char(signature);

    const res = await postResendWebhook(`v1,${invalidSignature}`, { payload });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid signature");
  });

  test("rejects an invalid different-length signature", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = makePayload();
    const signature = await signPayload(payload);

    const res = await postResendWebhook(`v1,${signature.slice(0, -4)}`, {
      payload,
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid signature");
  });

  test("rejects malformed or missing signature headers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = makePayload();
    const signature = await signPayload(payload);

    const malformed = await postResendWebhook("not-a-pair v1,");
    const extraFields = await postResendWebhook(`v1,${signature},extra`, {
      payload,
    });
    const missing = await postResendWebhook(undefined);

    expect(malformed.status).toBe(401);
    expect(await malformed.text()).toBe("Invalid signature");
    expect(extraFields.status).toBe(401);
    expect(await extraFields.text()).toBe("Invalid signature");
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("Invalid signature");
  });

  test("rejects stale timestamps", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = makePayload();
    const staleTimestamp = String(TEST_NOW_SECONDS - 301);
    const signature = await signPayload(payload, { timestamp: staleTimestamp });

    const res = await postResendWebhook(`v1,${signature}`, {
      payload,
      timestamp: staleTimestamp,
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid signature");
  });
});
