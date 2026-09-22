import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");
const SHARED_SECRET = "test-convex-secret-register-interest-7895";

function postHeaders(secret = SHARED_SECRET): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-convex-shared-secret": secret,
  };
}

async function post(
  t: ReturnType<typeof convexTest>,
  body: unknown,
  secret = SHARED_SECRET,
): Promise<Response> {
  return t.fetch("/api/internal-register-interest", {
    method: "POST",
    headers: postHeaders(secret),
    body: JSON.stringify(body),
  });
}

describe("registerInterest backing mutation", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SERVER_SHARED_SECRET = SHARED_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
    else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
  });

  test("requires the shared secret before parsing or writing", async () => {
    const t = convexTest(schema, modules);

    const missing = await t.fetch("/api/internal-register-interest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "missing-secret@example.com" }),
    });
    expect(missing.status).toBe(401);

    const wrong = await post(t, { email: "wrong-secret@example.com" }, "wrong-secret");
    expect(wrong.status).toBe(401);

    await expect(t.run((ctx) => ctx.db.query("registrations").collect())).resolves.toHaveLength(0);
  });

  test("rejects malformed JSON and invalid email without a write", async () => {
    const t = convexTest(schema, modules);
    const malformed = await t.fetch("/api/internal-register-interest", {
      method: "POST",
      headers: postHeaders(),
      body: "null",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "INVALID_JSON" });

    const invalid = await post(t, { email: "not-an-email" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "INVALID_EMAIL" });

    await expect(t.run((ctx) => ctx.db.query("registrations").collect())).resolves.toHaveLength(0);
  });

  test("writes registrations, counters, referral credits, and suppression state", async () => {
    const t = convexTest(schema, modules);

    const firstResponse = await post(t, {
      email: "first@example.com",
      source: "pro-waitlist",
      appVersion: "test",
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      status: string;
      referralCode: string;
      position: number;
      emailSuppressed: boolean;
    };
    expect(first).toMatchObject({
      status: "registered",
      position: 1,
      emailSuppressed: false,
    });

    const secondResponse = await post(t, {
      email: "second@example.com",
      referredBy: first.referralCode,
    });
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      status: "registered",
      position: 2,
    });

    await t.mutation(internal.emailSuppressions.suppress, {
      email: "suppressed@example.com",
      reason: "bounce",
    });
    const suppressedResponse = await post(t, { email: "suppressed@example.com" });
    expect(suppressedResponse.status).toBe(200);
    expect(await suppressedResponse.json()).toMatchObject({
      status: "registered",
      emailSuppressed: true,
    });

    const rows = await t.run((ctx) => ctx.db.query("registrations").collect());
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.email === "first@example.com")?.referralCount).toBe(1);
    expect(rows.find((row) => row.email === "second@example.com")?.referredBy).toBe(first.referralCode);
    await expect(
      t.run(async (ctx) => ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "registrations_total")).first()),
    ).resolves.toMatchObject({ value: 3 });
  });

  test("keeps the existing-registration response stable without creating a row", async () => {
    const t = convexTest(schema, modules);
    const initial = await post(t, { email: "repeat@example.com" });
    const initialBody = await initial.json() as { referralCode: string };

    const retry = await post(t, {
      email: "REPEAT@example.com",
      referredBy: "ignored-referrer",
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      status: "already_registered",
      referralCode: initialBody.referralCode,
      referralCount: 0,
    });

    await expect(t.run((ctx) => ctx.db.query("registrations").collect())).resolves.toHaveLength(1);
  });
});
