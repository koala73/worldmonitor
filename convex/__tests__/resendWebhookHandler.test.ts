import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { MAX_SIGNATURE_CANDIDATES } from "../lib/svixVerify";

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
  const { res } = await postResendWebhookWithTest(svixSignature, {
    payload,
    messageId,
    timestamp,
  });
  return res;
}

async function postResendWebhookWithTest(
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

  const res = await t.fetch("/resend-webhook", {
    method: "POST",
    headers,
    body: payload,
  });
  return { t, res };
}

describe("Resend webhook signature verification (#4678)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  test("only a bounded number of signature candidates is considered (#8491)", async () => {
    // The candidate cap landed in the Clerk verifier only (#8469); the shared
    // verifier carries it to every webhook. Burying the real signature past
    // the cap must fail closed, while a real rotation still verifies.
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = makePayload();
    const real = await signPayload(payload);
    const padding = Array.from(
      { length: MAX_SIGNATURE_CANDIDATES },
      (_, i) => `v1,${btoa(`pad-${i}`)}`,
    );

    const buried = await postResendWebhook([...padding, `v1,${real}`].join(" "), { payload });
    expect(buried.status).toBe(401);

    const rotated = await postResendWebhook(
      `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${real}`,
      { payload },
    );
    expect(rotated.status).toBe(200);
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

  test("a malformed or empty secret is a server error, not a 401", async () => {
    // Before the shared verifier this threw out of atob/importKey, which
    // Convex turns into a 500; keep that so Svix retries until it is fixed.
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    const payload = makePayload();
    const signature = await signPayload(payload);
    for (const secret of ["whsec_not*base64!", "whsec_"]) {
      process.env.RESEND_WEBHOOK_SECRET = secret;
      await expect(postResendWebhook(`v1,${signature}`, { payload }), secret).rejects.toThrow(
        "RESEND_WEBHOOK_SECRET is not a valid whsec_ secret",
      );
    }
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

  test("persists a signed contact.updated unsubscribe", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = JSON.stringify({
      type: "contact.updated",
      data: {
        id: "contact_unsubscribed",
        email: "  Opted.Out@Example.com ",
        unsubscribed: true,
      },
    });
    const signature = await signPayload(payload);

    const { t, res } = await postResendWebhookWithTest(`v1,${signature}`, {
      payload,
    });

    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalizedEmail: "opted.out@example.com",
      reason: "unsubscribe",
      source: "resend-webhook:contact_unsubscribed",
    });
    const message = log.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.startsWith("[resend-webhook] Suppressed"));
    expect(message).toContain("O***@Example.com");
    expect(message).not.toContain("Opted.Out@Example.com");
  });

  test("does not treat a contact.updated resubscribe as an unsubscribe", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    const payload = JSON.stringify({
      type: "contact.updated",
      data: {
        id: "contact_resubscribed",
        email: "resubscribed@example.com",
        unsubscribed: false,
      },
    });
    const signature = await signPayload(payload);

    const { t, res } = await postResendWebhookWithTest(`v1,${signature}`, {
      payload,
    });

    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows).toEqual([]);
  });
});

describe("Resend webhook bounce classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  async function post(
    t: ReturnType<typeof convexTest>,
    event: Record<string, unknown>,
    messageId: string,
  ) {
    const payload = JSON.stringify(event);
    const signature = await signPayload(payload, { messageId });
    return await t.fetch("/resend-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": messageId,
        "svix-timestamp": String(TEST_NOW_SECONDS),
        "svix-signature": `v1,${signature}`,
      },
      body: payload,
    });
  }

  // Payload shape from https://resend.com/docs/webhooks/emails/bounced
  function bounced(emailId: string, type: string, subType: string, createdAt = "2023-11-14T22:13:20.000Z") {
    return {
      type: "email.bounced",
      created_at: createdAt,
      data: {
        email_id: emailId,
        to: ["Soft.Bounce@Example.com"],
        bounce: { type, subType, message: "smtp; 452 4.2.2 mailbox full" },
      },
    };
  }

  function setup() {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.RESEND_WEBHOOK_SECRET = RESEND_WEBHOOK_SECRET;
    return convexTest(schema, modules);
  }

  test("a Permanent bounce suppresses at once", async () => {
    const t = setup();
    const res = await post(t, bounced("e_hard", "Permanent", "General"), "msg_hard");
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalizedEmail: "soft.bounce@example.com",
      reason: "bounce",
      source: "resend-webhook:e_hard",
    });
  });

  test("a bounce without a bounce object keeps the permanent behaviour", async () => {
    const t = setup();
    const event = bounced("e_legacy", "Permanent", "General");
    delete (event.data as { bounce?: unknown }).bounce;
    await post(t, event, "msg_legacy");
    const rows = await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
    expect(rows).toHaveLength(1);
  });

  test("Transient bounces suppress only on the third distinct message", async () => {
    const t = setup();
    await post(t, bounced("e1", "Transient", "MailboxFull"), "msg_s1");
    await post(t, bounced("e1", "Transient", "MailboxFull"), "msg_s1_retry");
    await post(t, bounced("e2", "Undetermined", "Undetermined"), "msg_s2");
    let rows = await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
    expect(rows).toEqual([]);

    const res = await post(t, bounced("e3", "Transient", "General"), "msg_s3");
    expect(res.status).toBe(200);
    rows = await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("bounce");
    expect(rows[0]!.source).toMatch(/^soft-bounce:3-in-30d:resend-webhook:e3$/);
  });

  test("content-caused soft bounces and delivery delays are not strikes", async () => {
    const t = setup();
    await post(t, bounced("e1", "Transient", "MessageTooLarge"), "msg_c1");
    await post(t, bounced("e2", "Transient", "ContentRejected"), "msg_c2");
    for (const [i, id] of ["e3", "e4", "e5"].entries()) {
      // Payload shape from https://resend.com/docs/webhooks/emails/delivery-delayed
      await post(t, {
        type: "email.delivery_delayed",
        created_at: "2023-11-14T22:13:20.000Z",
        data: { email_id: id, to: ["soft.bounce@example.com"] },
      }, `msg_d${i}`);
    }
    const strikes = await t.run(async (ctx) => await ctx.db.query("emailSoftBounces").collect());
    const rows = await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
    expect(strikes).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("email.delivered clears earlier strikes", async () => {
    const t = setup();
    await post(t, bounced("e1", "Transient", "MailboxFull", "2023-11-14T21:00:00.000Z"), "msg_s1");
    await post(t, bounced("e2", "Transient", "MailboxFull", "2023-11-14T21:30:00.000Z"), "msg_s2");
    const res = await post(t, {
      type: "email.delivered",
      created_at: "2023-11-14T22:00:00.000Z",
      data: { email_id: "e_ok", to: ["SOFT.BOUNCE@example.com"] },
    }, "msg_ok");
    expect(res.status).toBe(200);
    await post(t, bounced("e3", "Transient", "MailboxFull"), "msg_s3");
    const strikes = await t.run(async (ctx) => await ctx.db.query("emailSoftBounces").collect());
    const rows = await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
    expect(strikes).toHaveLength(1);
    expect(rows).toEqual([]);
  });

  test("a delivery before any bounce prevents stale webhooks from suppressing the address", async () => {
    const t = setup();
    const delivery = {
      type: "email.delivered",
      created_at: "2023-11-14T22:00:00.000Z",
      data: { email_id: "recovered", to: ["soft.bounce@example.com"] },
    };
    expect((await post(t, delivery, "msg_recovered")).status).toBe(200);
    for (const id of ["late1", "late2", "late3"]) {
      expect((await post(t, bounced(id, "Transient", "MailboxFull", "2023-11-14T21:00:00.000Z"), id)).status).toBe(200);
    }
    for (const id of ["new1", "new2"]) {
      expect((await post(t, bounced(id, "Transient", "MailboxFull"), id)).status).toBe(200);
    }
    // Retrying the earlier delivery must not erase failures that happened later.
    expect((await post(t, delivery, "msg_recovered")).status).toBe(200);
    const strikes = await t.run((ctx) => ctx.db.query("emailSoftBounces").collect());
    expect(strikes).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("emailSuppressions").collect())).toEqual([]);
    expect((await post(t, bounced("new3", "Transient", "MailboxFull"), "new3")).status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("emailSuppressions").collect())).toHaveLength(1);
  });

  test("a broadcast-tagged delivery still records the broadcast event", async () => {
    const t = setup();
    const res = await post(t, {
      type: "email.delivered",
      created_at: "2023-11-14T22:13:20.000Z",
      data: { email_id: "e_b", broadcast_id: "b_1", to: ["x@example.com"] },
    }, "msg_bdel");
    expect(res.status).toBe(200);
    const events = await t.run(async (ctx) => await ctx.db.query("broadcastEvents").collect());
    expect(events).toHaveLength(1);
  });
});
