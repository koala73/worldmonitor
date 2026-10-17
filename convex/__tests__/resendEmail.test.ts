/**
 * Shared Resend sender (convex/lib/resendEmail.ts): suppression is checked
 * before every POST and a human Reply-To is set by default. Also covers two
 * senders that used to skip the local suppression check entirely: the
 * subscription welcome email and the business-seat emails.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  DEFAULT_REPLY_TO,
  RESEND_EMAILS_URL,
  ResendSendError,
  buildResendEmailPayload,
  sendResendEmail,
} from "../lib/resendEmail";

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
