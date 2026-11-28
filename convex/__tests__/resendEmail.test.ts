/**
 * Shared Resend sender (convex/lib/resendEmail.ts): suppression is checked
 * before every POST and a human Reply-To is set by default. Also covers two
 * senders that used to skip the local suppression check entirely: the
 * subscription welcome email and the business-seat emails.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  DEFAULT_REPLY_TO,
  RESEND_EMAILS_URL,
  RESEND_RATE_LIMIT_RETRY_DELAYS_MS,
  ResendSendError,
  buildResendEmailPayload,
  sendResendEmail,
  setResendRetrySleepForTests,
} from "../lib/resendEmail";
import { createResendBroadcast } from "../broadcast/sendBroadcast";
import { createSegment } from "../broadcast/_resendContacts";

const modules = import.meta.glob("../**/*.ts");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
});

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
}

function resendBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === RESEND_EMAILS_URL)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

const base = {
  apiKey: "re_test",
  from: "World Monitor <noreply@worldmonitor.app>",
  to: "reader@example.com",
  subject: "Subject",
  html: "<p>hi</p>",
  purpose: "transactional" as const,
};

describe("buildResendEmailPayload", () => {
  test("defaults reply_to to support@", () => {
    expect(buildResendEmailPayload(base)).toMatchObject({ reply_to: DEFAULT_REPLY_TO, to: ["reader@example.com"] });
    expect(DEFAULT_REPLY_TO).toBe("support@worldmonitor.app");
  });

  test("an explicit reply_to wins and null omits it", () => {
    expect(buildResendEmailPayload({ ...base, replyTo: "elie@worldmonitor.app" }).reply_to).toBe("elie@worldmonitor.app");
    expect("reply_to" in buildResendEmailPayload({ ...base, replyTo: null })).toBe(false);
  });

  test("passes custom headers and text through", () => {
    const payload = buildResendEmailPayload({ ...base, text: "hi", headers: { "X-Test": "1" } });
    expect(payload.text).toBe("hi");
    expect(payload.headers).toEqual({ "X-Test": "1" });
    expect("headers" in buildResendEmailPayload(base)).toBe(false);
  });
});

describe("sendResendEmail", () => {
  test("skips the POST for a suppressed recipient", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = { runQuery: vi.fn(async () => true) };
    const result = await sendResendEmail(ctx as never, base);
    expect(result).toEqual({ sent: false, reason: "suppressed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.runQuery).toHaveBeenCalledWith(expect.anything(), {
      email: "reader@example.com",
      purpose: "transactional",
    });
  });

  test("sends with the default reply_to when not suppressed", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendResendEmail({ runQuery: async () => false } as never, base);
    expect(result).toEqual({ sent: true, id: "email_1" });
    expect(resendBodies(fetchMock)).toEqual([expect.objectContaining({ reply_to: DEFAULT_REPLY_TO })]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("worldmonitor-convex/1.0");
  });

  test("throws ResendSendError on a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 422 })));
    await expect(sendResendEmail({ runQuery: async () => false } as never, base))
      .rejects.toBeInstanceOf(ResendSendError);
  });

  test("a broadcast unsubscribe blocks marketing but not transactional mail", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "Reader@Example.com",
      reason: "unsubscribe",
      source: "test",
    });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      runQuery: (ref: never, args: never) => t.query(ref, args),
    };
    expect(await sendResendEmail(ctx as never, { ...base, purpose: "marketing" }))
      .toEqual({ sent: false, reason: "suppressed" });
    expect(await sendResendEmail(ctx as never, base)).toEqual({ sent: true, id: "email_1" });
    expect(resendBodies(fetchMock)).toHaveLength(1);
  });
});

describe("Resend 429 retry (account-wide 10 req/s limit)", () => {
  let restoreSleep: () => void = () => {};
  const sleeps: number[] = [];
  beforeEach(() => {
    sleeps.length = 0;
    restoreSleep = setResendRetrySleepForTests(async (ms) => {
      sleeps.push(ms);
    });
  });
  afterEach(() => restoreSleep());

  function rateLimited(headers: Record<string, string> = {}) {
    return new Response(JSON.stringify({ name: "rate_limit_exceeded", statusCode: 429 }), { status: 429, headers });
  }

  test("sendResendEmail delivers after a transient 429", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "email_2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendResendEmail({ runQuery: async () => false } as never, base);
    expect(result).toEqual({ sent: true, id: "email_2" });
    expect(resendBodies(fetchMock)).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  test("honours Retry-After, capped", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimited({ "retry-after": "1" }))
      .mockResolvedValueOnce(rateLimited({ "retry-after": "60" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "email_3" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendResendEmail({ runQuery: async () => false } as never, base);
    expect(sleeps).toEqual([1_000, 5_000]);
  });

  test("a persistent 429 still fails, after a bounded number of attempts", async () => {
    const fetchMock = vi.fn(async () => rateLimited());
    vi.stubGlobal("fetch", fetchMock);
    const err = await sendResendEmail({ runQuery: async () => false } as never, base).catch((e) => e);
    expect(err).toBeInstanceOf(ResendSendError);
    expect((err as ResendSendError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(RESEND_RATE_LIMIT_RETRY_DELAYS_MS.length + 1);
  });

  test("other failures are not retried", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendResendEmail({ runQuery: async () => false } as never, base))
      .rejects.toBeInstanceOf(ResendSendError);
    const serverError = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", serverError);
    await expect(sendResendEmail({ runQuery: async () => false } as never, base))
      .rejects.toBeInstanceOf(ResendSendError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(serverError).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test("broadcast create survives a transient 429 (WORLDMONITOR-1GQ shape)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "bc_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await createResendBroadcast("re_test", "test", {
      name: "n", segmentId: "seg_1", from: "f@x.test", replyTo: "r@x.test", subject: "s", html: "<p/>", text: "t",
    });
    expect(id).toBe("bc_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("segment create survives a transient 429", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "seg_9" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createSegment("re_test", "seg-name")).toBe("seg_9");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("broadcast SEND is never retried: a stop during the wait could not be honoured", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn(async () => rateLimited());
    vi.stubGlobal("fetch", fetchMock);
    await expect(t.action(internal.broadcast.sendBroadcast.sendProLaunchBroadcast, { broadcastId: "bc_1" }))
      .rejects.toThrow(/Resend 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test("an address suppressed during the 429 wait is not sent to", async () => {
    const fetchMock = vi.fn(async () => rateLimited());
    vi.stubGlobal("fetch", fetchMock);
    const runQuery = vi.fn()
      .mockResolvedValueOnce(false) // before the first POST
      .mockResolvedValueOnce(true); // unsubscribed while waiting
    const result = await sendResendEmail({ runQuery } as never, { ...base, purpose: "marketing" });
    expect(result).toEqual({ sent: false, reason: "suppressed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});

describe("senders that used to skip local suppression", () => {
  test("welcome email is not sent to a bounced address; admin notice still goes out", async () => {
    const t = convexTest(schema, modules);
    process.env.RESEND_API_KEY = "re_test";
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "bounced@example.com",
      reason: "bounce",
      source: "test",
    });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.payments.subscriptionEmails.sendSubscriptionEmails, {
      userEmail: "bounced@example.com",
      planKey: "pro_monthly",
      userId: "user_bounced",
    });

    const bodies = resendBodies(fetchMock);
    expect(bodies.map((b) => b.to)).toEqual([["elie@worldmonitor.app"]]);
    // Admin notice to our own inbox carries no Reply-To (no self-loop).
    expect("reply_to" in bodies[0]!).toBe(false);
  });

  test("welcome email keeps the elie@ reply_to for a deliverable address", async () => {
    const t = convexTest(schema, modules);
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.payments.subscriptionEmails.sendSubscriptionEmails, {
      userEmail: "buyer@example.com",
      planKey: "pro_monthly",
      userId: "user_buyer",
    });

    const welcome = resendBodies(fetchMock).find((b) => (b.to as string[])[0] === "buyer@example.com");
    expect(welcome?.reply_to).toBe("elie@worldmonitor.app");
  });

  test("business-seat invite is not sent to a complained address", async () => {
    const t = convexTest(schema, modules);
    process.env.RESEND_API_KEY = "re_test";
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "invitee@acme.com",
      reason: "complaint",
      source: "test",
    });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.payments.businessSeats.sendBusinessInviteEmail, {
      inviteeEmail: "invitee@acme.com",
      ownerEmail: "owner@acme.com",
      grantId: "grant_123456789",
      token: "tok",
    });
    await t.action(internal.payments.businessSeats.sendTeamAccessEndedEmail, {
      inviteeEmail: "invitee@acme.com",
    });

    expect(resendBodies(fetchMock)).toHaveLength(0);
  });

  test("business-seat mail to a deliverable address replies to support@", async () => {
    const t = convexTest(schema, modules);
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.payments.businessSeats.sendTeamAccessEndedEmail, {
      inviteeEmail: "member@acme.com",
    });

    expect(resendBodies(fetchMock)).toEqual([
      expect.objectContaining({ to: ["member@acme.com"], reply_to: "support@worldmonitor.app" }),
    ]);
  });
});
