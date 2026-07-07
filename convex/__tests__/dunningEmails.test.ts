/**
 * Dunning + winback email lifecycle (#4932).
 *
 * Coverage map (every guard has a test because each one, if silently
 * removed, emails real customers wrongly):
 *   - on_hold webhook sets the episode anchor and schedules day-0 exactly
 *     once (replays keep the anchor, no re-send)
 *   - send action: per-episode idempotency, suppression skip, recovered-sub
 *     skip, stale-episode skip, email resolution fallback to customers row
 *   - daily scan: day-3/day-7 windows, at most ONE step per sub per tick
 *     (pre-existing holds get a single catch-up email), ledger pre-check
 *   - winback: 30–60d window, skips while still entitled, skips
 *     resubscribed users, one-shot
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  DUNNING_DAY3_AGE_MS,
  DUNNING_DAY7_AGE_MS,
  WINBACK_MIN_AGE_MS,
  WINBACK_MAX_AGE_MS,
} from "../payments/subscriptionEmails";

const modules = import.meta.glob("../**/*.ts");

const DAY_MS = 86_400_000;
const SUB_ID = "sub_dunning_test_1";
const USER_ID = "user_dunning_1";
const EMAIL = "holdout@example.com";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.RESEND_API_KEY;
});

function mockResend() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
}

/** Parse the Resend payloads out of the fetch mock (filters non-Resend calls). */
function resendSends(fetchMock: ReturnType<typeof mockResend>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("api.resend.com"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
      to: string[];
      subject: string;
      html: string;
    });
}

async function seedSub(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    dodoSubscriptionId: string;
    userId: string;
    status: "active" | "on_hold" | "cancelled" | "expired";
    onHoldAt: number;
    cancelledAt: number;
    currentPeriodEnd: number;
    updatedAt: number;
    email: string | null;
    planKey: string;
  }> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: overrides.userId ?? USER_ID,
      dodoSubscriptionId: overrides.dodoSubscriptionId ?? SUB_ID,
      dodoProductId: "pdt_test",
      planKey: overrides.planKey ?? "pro_monthly",
      status: overrides.status ?? "on_hold",
      currentPeriodStart: Date.now() - 20 * DAY_MS,
      currentPeriodEnd: overrides.currentPeriodEnd ?? Date.now() + 10 * DAY_MS,
      ...(overrides.cancelledAt !== undefined ? { cancelledAt: overrides.cancelledAt } : {}),
      ...(overrides.onHoldAt !== undefined ? { onHoldAt: overrides.onHoldAt } : {}),
      rawPayload:
        overrides.email === null
          ? { subscription_id: overrides.dodoSubscriptionId ?? SUB_ID }
          : { subscription_id: overrides.dodoSubscriptionId ?? SUB_ID, customer: { email: overrides.email ?? EMAIL } },
      updatedAt: overrides.updatedAt ?? Date.now() - 1000,
    });
  });
}

async function ledgerRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("dunningEmails").collect());
}

describe("on_hold webhook → day-0 email", () => {
  test("transition into on_hold sets the anchor and sends day-0 once", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, { status: "active", updatedAt: Date.now() - 5000 });

    const eventTs = Date.now();
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_hold_1",
      eventType: "subscription.on_hold",
      rawPayload: { data: { subscription_id: SUB_ID, customer: { email: EMAIL } } },
      timestamp: eventTs,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique(),
    );
    expect(sub?.status).toBe("on_hold");
    expect(sub?.onHoldAt).toBe(eventTs);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([EMAIL]);
    expect(sends[0]!.subject).toContain("payment failed");
    expect(await ledgerRows(t)).toHaveLength(1);

    // Replay: a second on_hold webhook while already on_hold keeps the
    // anchor and does NOT re-send day-0 (ledger + enteringHold guard).
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_hold_2",
      eventType: "subscription.on_hold",
      rawPayload: { data: { subscription_id: SUB_ID } },
      timestamp: eventTs + 60_000,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sub2 = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique(),
    );
    expect(sub2?.onHoldAt).toBe(eventTs);
    expect(resendSends(fetchMock)).toHaveLength(1);
  });
});

describe("sendDunningEmail guards", () => {
  test("second invocation for the same step+episode is a no-op", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const anchor = Date.now() - 4 * DAY_MS;
    await seedSub(t, { onHoldAt: anchor });

    const args = { dodoSubscriptionId: SUB_ID, step: "dunning_day3" as const, episodeAt: anchor };
    const first = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, args);
    expect(first).toEqual({ sent: true });
    const second = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, args);
    expect(second).toEqual({ sent: false, reason: "already_sent" });
    expect(resendSends(fetchMock)).toHaveLength(1);
  });

  test("suppressed recipient is never emailed", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const anchor = Date.now() - 4 * DAY_MS;
    await seedSub(t, { onHoldAt: anchor });
    await t.run(async (ctx) => {
      await ctx.db.insert("emailSuppressions", {
        normalizedEmail: EMAIL,
        reason: "bounce",
        suppressedAt: Date.now(),
      });
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "dunning_day3",
      episodeAt: anchor,
    });
    expect(result).toEqual({ sent: false, reason: "suppressed" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("recovered subscription (active again) skips a scheduled dunning send", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const anchor = Date.now() - 4 * DAY_MS;
    await seedSub(t, { status: "active", onHoldAt: anchor });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "dunning_day3",
      episodeAt: anchor,
    });
    expect(result).toEqual({ sent: false, reason: "recovered" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("a newer on_hold episode invalidates sends scheduled for the old one", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const oldAnchor = Date.now() - 40 * DAY_MS;
    const newAnchor = Date.now() - 1 * DAY_MS;
    await seedSub(t, { onHoldAt: newAnchor });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "dunning_day7",
      episodeAt: oldAnchor,
    });
    expect(result).toEqual({ sent: false, reason: "stale_episode" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("falls back to the customers row when rawPayload has no email", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const anchor = Date.now() - 4 * DAY_MS;
    await seedSub(t, { onHoldAt: anchor, email: null });
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: USER_ID,
        dodoCustomerId: "cus_test",
        email: "fallback@example.com",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "dunning_day3",
      episodeAt: anchor,
    });
    expect(result).toEqual({ sent: true });
    expect(resendSends(fetchMock)[0]!.to).toEqual(["fallback@example.com"]);
  });
});

describe("runDunningScan windows", () => {
  test("4-day-old hold gets day-3 only; scan is idempotent across ticks", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, { onHoldAt: Date.now() - (DUNNING_DAY3_AGE_MS + DAY_MS) });

    const summary = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(summary.scheduled).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("Reminder");

    const again = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(again.scheduled).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);
  });

  test("pre-existing 20-day hold (no onHoldAt) gets ONE catch-up email — the final notice", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    // Pre-deploy row shape: on_hold with no onHoldAt; updatedAt is the anchor.
    await seedSub(t, { updatedAt: Date.now() - 20 * DAY_MS });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("Final notice");
  });

  test("day-7 fires after day-3 was already sent for the same episode", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const anchor = Date.now() - (DUNNING_DAY7_AGE_MS + DAY_MS);
    await seedSub(t, { onHoldAt: anchor });
    // Simulate the day-3 send having happened earlier in this episode.
    await t.run(async (ctx) => {
      await ctx.db.insert("dunningEmails", {
        dodoSubscriptionId: SUB_ID,
        step: "dunning_day3",
        episodeAt: anchor,
        email: EMAIL,
        sentAt: anchor + DUNNING_DAY3_AGE_MS,
      });
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("Final notice");
    expect(await ledgerRows(t)).toHaveLength(2);
  });

  test("repeat on_hold webhook does NOT re-open a finished pre-existing episode (PR #4935 F1)", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    // Pre-#4932 row: on_hold for 20 days, no onHoldAt — updatedAt is the anchor.
    const anchor = Date.now() - 20 * DAY_MS;
    await seedSub(t, { updatedAt: anchor });

    // Catch-up scan sends the final notice for episode `anchor`.
    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);

    // A Dodo payment-retry failure fires another on_hold webhook. The anchor
    // must FREEZE at the pre-patch updatedAt — falling back to the event
    // timestamp would restart the 3/7-day clock and re-send the sequence.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_repeat_hold",
      eventType: "subscription.on_hold",
      rawPayload: { data: { subscription_id: SUB_ID } },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique(),
    );
    expect(sub?.onHoldAt).toBe(anchor);

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);
  });

  test("fresh hold (1 day old) is not emailed by the scan", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, { onHoldAt: Date.now() - DAY_MS });

    const summary = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(summary.scheduled).toBe(0);
    expect(resendSends(fetchMock)).toHaveLength(0);
  });
});

describe("winback", () => {
  test("access ended 35 days ago gets exactly one winback", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: Date.now() - 40 * DAY_MS,
      currentPeriodEnd: Date.now() - (WINBACK_MIN_AGE_MS + 5 * DAY_MS),
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("access has ended");

    const again = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(again.scheduled).toBe(0);
  });

  test("annual who cancelled months early gets the winback once access lapses (round-2 F3)", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    // Cancelled 8 months ago, but the paid annual period only lapsed 32 days
    // ago. A cancelledAt-keyed window would NEVER select this row (paid-
    // through inside it, outside it afterwards); the access-end window must.
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: Date.now() - 240 * DAY_MS,
      currentPeriodEnd: Date.now() - 32 * DAY_MS,
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("access has ended");
  });

  test("pending winback for a superseded cancellation episode is dropped (round-2 F1)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const currentEpisode = Date.now() - 40 * DAY_MS;
    const staleEpisode = Date.now() - 100 * DAY_MS;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: currentEpisode,
      currentPeriodEnd: Date.now() - 35 * DAY_MS,
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "winback_day30",
      episodeAt: staleEpisode,
    });
    expect(result).toEqual({ sent: false, reason: "stale_episode" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("cancelled-but-paid-through sibling still counts as covered (round-2 F2)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 40 * DAY_MS;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() - 35 * DAY_MS,
    });
    // Sibling annual: cancelled, but paid through for months — the user is
    // still entitled, so "your access has ended" must not go out.
    await seedSub(t, {
      dodoSubscriptionId: "sub_annual_paid_through",
      status: "cancelled",
      cancelledAt: Date.now() - 10 * DAY_MS,
      currentPeriodEnd: Date.now() + 200 * DAY_MS,
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "winback_day30",
      episodeAt: cancelledAt,
    });
    expect(result).toEqual({ sent: false, reason: "resubscribed" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("still-entitled cancellation (annual paid through) is not winback-emailed", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: Date.now() - (WINBACK_MIN_AGE_MS + 5 * DAY_MS),
      currentPeriodEnd: Date.now() + 200 * DAY_MS,
    });

    const summary = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(summary.scheduled).toBe(0);
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("historic cancellation outside the 60-day window is never mass-mailed", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: Date.now() - (WINBACK_MAX_AGE_MS + 30 * DAY_MS),
      currentPeriodEnd: Date.now() - 90 * DAY_MS,
    });

    const summary = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(summary.scheduled).toBe(0);
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("repeat cancelled-flavored subscription.updated does NOT re-open the winback (round-4 F1)", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const anchor = Date.now() - 40 * DAY_MS;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: anchor,
      currentPeriodEnd: Date.now() - 35 * DAY_MS,
      updatedAt: anchor,
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);

    // Dodo re-sends a cancellation-flavored subscription.updated with NO
    // cancelled_at. The anchor must freeze — rewriting it to the event
    // timestamp re-keys the winback ledger and the one-shot fires again.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_repeat_cancel",
      eventType: "subscription.updated",
      rawPayload: { data: { subscription_id: SUB_ID, status: "cancelled" } },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique(),
    );
    expect(sub?.cancelledAt).toBe(anchor);

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);
  });

  test("comped user (compUntil in the future) is not winback-emailed (round-4 F5)", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 40 * DAY_MS;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() - 35 * DAY_MS,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: USER_ID,
        planKey: "pro_monthly",
        features: {
          tier: 1,
          maxDashboards: 10,
          apiAccess: false,
          apiRateLimit: 0,
          prioritySupport: false,
          exportFormats: ["csv", "pdf"],
          mcpAccess: true,
        },
        validUntil: Date.now() - 35 * DAY_MS,
        compUntil: Date.now() + 30 * DAY_MS,
        updatedAt: Date.now() - 35 * DAY_MS,
      });
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "winback_day30",
      episodeAt: cancelledAt,
    });
    expect(result).toEqual({ sent: false, reason: "still_entitled" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("resubscribed user (live sibling sub) is not winback-emailed", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - (WINBACK_MIN_AGE_MS + 5 * DAY_MS);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() - 5 * DAY_MS,
    });
    await seedSub(t, {
      dodoSubscriptionId: "sub_new_life",
      status: "active",
      currentPeriodEnd: Date.now() + 20 * DAY_MS,
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "winback_day30",
      episodeAt: cancelledAt,
    });
    expect(result).toEqual({ sent: false, reason: "resubscribed" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });
});
