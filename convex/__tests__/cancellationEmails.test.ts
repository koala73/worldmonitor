/**
 * Cancellation confirmation email (#7314 / #7328).
 *
 * Split out of dunningEmails.test.ts so the dunning + winback suite stays
 * navigable. Shared fixture setup here is only what these cases need.
 *
 * Coverage map (every guard has a test because each one, if silently
 * removed, emails real customers wrongly):
 *   - cancellation confirmation: paid-through cancellation emails the
 *     ACCESS-END DATE once, replays don't re-send, lapsed cancellations stay
 *     silent, a first cancellation that omits `customer` still reaches the
 *     stored recipient when there is no customers row, a new cancellation
 *     episode re-sends
 *   - shared ledger: the confirmation row does not suppress the later winback
 *   - cancellation copy: UTC date formatting, plan-neutral body (this step
 *     fires for api_* plans too), dateless fallback
 *   - cancellation retry: the daily scan re-queues a confirmation that never
 *     landed (Resend threw before the ledger write, or the webhook skipped
 *     because RESEND_API_KEY was missing), dedups against the ledger, and is
 *     age-capped (index-bounded by cancelledAt) so the first deploy doesn't
 *     mass-mail every historic paid-through canceller
 *   - cancellation send re-reads after the uncapped Resend wait: a resume
 *     (or expiry / new episode / suppression) during pacing must not send
 *     the pre-wait snapshot
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  CANCELLATION_CONFIRM_RETRY_MAX_AGE_MS,
  RESEND_SLOT_COUNTER,
  WINBACK_MIN_AGE_MS,
  buildDunningEmail,
} from "../payments/subscriptionEmails";
import {
  buildCancellationConfirmEmail,
  formatAccessEndDate,
} from "../payments/cancellationEmailCopy";

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

describe("cancellation confirmation email (#7314)", () => {
  // The escalation this exists to prevent: a subscriber renews, cancels the
  // same day, and — told nothing — asks for a refund of a month they still
  // hold. Every test below asserts the ACCESS-END DATE reaches the recipient,
  // because "an email went out" was never the missing thing.

  test("cancelling a still-covering sub sends one email naming the access-end date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T19:56:22Z"));
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const periodEnd = Date.parse("2026-09-28T19:01:10Z");
    await seedSub(t, {
      status: "active",
      currentPeriodEnd: periodEnd,
      updatedAt: Date.now() - 5000,
    });

    const eventTs = Date.now();
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_1",
      eventType: "subscription.cancelled",
      rawPayload: {
        data: { subscription_id: SUB_ID, customer: { email: EMAIL } },
      },
      timestamp: eventTs,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([EMAIL]);
    // The whole point: the body must state when access actually ends. A test
    // that only asserted an email was sent would pass against a body that
    // says "your subscription has been cancelled" and nothing else — the
    // exact failure that produced the refund request.
    expect(sends[0]!.html).toContain("28 September 2026");
    expect(sends[0]!.subject).toContain("28 September 2026");
    expect(await ledgerRows(t)).toHaveLength(1);
  });

  test("first cancellation without customer keeps the stored recipient and still sends", async () => {
    // The failure this covers: Dodo lifecycle events often omit `customer`.
    // A blind rawPayload patch would erase the only stored email; with no
    // customers row, both the webhook send and the daily retry end as
    // `no_email`. The stored payload must keep the prior recipient so
    // getDunningContext can resolve it after the patch.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T19:56:22Z"));
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const periodEnd = Date.parse("2026-09-28T19:01:10Z");
    await seedSub(t, {
      status: "active",
      currentPeriodEnd: periodEnd,
      updatedAt: Date.now() - 5000,
    });
    // seedSub writes the email on the subscription payload only — no
    // customers row. Verified by mutation: a blind `rawPayload: data`
    // patch turns this red (`no_email`).
    const customersBefore = await t.run(async (ctx) => ctx.db.query("customers").collect());
    expect(customersBefore).toHaveLength(0);

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_no_customer",
      eventType: "subscription.cancelled",
      rawPayload: { data: { subscription_id: SUB_ID } },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([EMAIL]);
    expect(sends[0]!.html).toContain("28 September 2026");
    expect(await ledgerRows(t)).toHaveLength(1);

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique(),
    );
    expect(
      (sub?.rawPayload as { customer?: { email?: string } } | null)?.customer?.email,
    ).toBe(EMAIL);
  });

  test("webhook replay of the same cancellation sends no second email", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "active",
      currentPeriodEnd: Date.now() + 30 * DAY_MS,
      updatedAt: Date.now() - 5000,
    });

    const eventTs = Date.now();
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_replay_1",
      eventType: "subscription.cancelled",
      rawPayload: { data: { subscription_id: SUB_ID, customer: { email: EMAIL } } },
      timestamp: eventTs,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);

    // A `subscription.updated` carrying status=cancelled routes to the same
    // handler and often arrives WITHOUT a stable cancelled_at — the anchor
    // must not move, or the ledger key changes and the customer is emailed
    // the same cancellation twice.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_replay_2",
      eventType: "subscription.cancelled",
      rawPayload: { data: { subscription_id: SUB_ID } },
      timestamp: eventTs + 60_000,
    });

    // The replay must not even ENQUEUE a second send. Asserting only "one
    // email went out" leaves the `enteringCancelled` guard untested, because
    // the ledger would swallow the duplicate at send time — and that ledger
    // dedup is explicitly best-effort, not exactly-once (two concurrent
    // invocations can both pass wasDunningStepSent before either records).
    // The guard is the layer that stops the second invocation existing.
    // Verified by mutation: dropping `enteringCancelled` turns this red.
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.state.kind === "pending" || job.state.kind === "inProgress",
      ),
    );
    expect(pending).toHaveLength(0);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);
    expect(await ledgerRows(t)).toHaveLength(1);
  });

  test("cancelling an already-lapsed sub sends nothing", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    // Access already ended — "your access continues until <past date>" would
    // be actively wrong, so this cancellation must stay silent.
    await seedSub(t, {
      status: "on_hold",
      currentPeriodEnd: Date.now() - 3 * DAY_MS,
      updatedAt: Date.now() - 5000,
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_lapsed",
      eventType: "subscription.cancelled",
      rawPayload: { data: { subscription_id: SUB_ID, customer: { email: EMAIL } } },
      timestamp: Date.now(),
    });

    // Assert at the SCHEDULING layer, before draining the queue. The send
    // action re-checks coverage itself, so a "no email was sent" assertion
    // alone stays green with the webhook-side guard deleted — it would only
    // prove the second line of defence. Checking the queue is what pins the
    // first one (verified by mutation: dropping `stillPaidThrough` from
    // handleSubscriptionCancelled turns this red).
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(0);
    expect(await ledgerRows(t)).toHaveLength(0);
  });

  test("a newer payload next_billing_date is persisted and used for the confirmation", async () => {
    // Missed renewal: stored period already ended, but the cancellation
    // payload carries the renewed next_billing_date. Coverage, email copy,
    // and the persisted row must all use that later date — once cancelled,
    // active-only reconciliation cannot repair the stale currentPeriodEnd.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T19:56:22Z"));
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "active",
      currentPeriodEnd: Date.parse("2026-08-27T19:01:10Z"),
      updatedAt: Date.now() - 5000,
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_stale_period",
      eventType: "subscription.cancelled",
      rawPayload: {
        data: {
          subscription_id: SUB_ID,
          customer: { email: EMAIL },
          next_billing_date: "2026-09-27T19:01:10Z",
        },
      },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique(),
    );
    expect(sub?.currentPeriodEnd).toBe(Date.parse("2026-09-27T19:01:10Z"));

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.html).toContain("27 September 2026");
    expect(sends[0]!.subject).toContain("27 September 2026");
    expect(await ledgerRows(t)).toHaveLength(1);
  });

  test("cancel → renew → cancel is a new episode and emails again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T19:56:22Z"));
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "active",
      currentPeriodEnd: Date.parse("2026-09-28T19:01:10Z"),
      updatedAt: Date.now() - 5000,
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_ep1",
      eventType: "subscription.cancelled",
      rawPayload: { data: { subscription_id: SUB_ID, customer: { email: EMAIL } } },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);

    // Reactivation via a real renewal, then a second cancellation months
    // later. The `enteringCancelled` re-anchor must open a fresh episode so
    // this genuinely-new cancellation is confirmed too.
    vi.setSystemTime(new Date("2026-10-28T19:01:10Z"));
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_renew_ep2",
      eventType: "subscription.renewed",
      rawPayload: {
        data: {
          subscription_id: SUB_ID,
          customer: { email: EMAIL },
          previous_billing_date: "2026-10-28T19:01:10Z",
          next_billing_date: "2026-11-28T19:01:10Z",
        },
      },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    vi.setSystemTime(new Date("2026-10-28T20:30:00Z"));
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_ep2",
      eventType: "subscription.cancelled",
      rawPayload: { data: { subscription_id: SUB_ID, customer: { email: EMAIL } } },
      timestamp: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(2);
    // The second email must carry the NEW period end, not the first one's.
    expect(sends[1]!.html).toContain("28 November 2026");
    expect(await ledgerRows(t)).toHaveLength(2);
  });

  test("send action re-checks coverage: a sub that lapsed after scheduling is skipped", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 60_000;
    // Scheduled while covering, runs after the period ended (detached action,
    // same defensive re-validation every other step does).
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() - 1000,
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "cancellation_confirm",
      episodeAt: cancelledAt,
    });
    expect(result).toEqual({ sent: false, reason: "not_covering" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("send action skips a sub that is no longer cancelled", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 60_000;
    await seedSub(t, {
      status: "active",
      cancelledAt,
      currentPeriodEnd: Date.now() + 20 * DAY_MS,
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "cancellation_confirm",
      episodeAt: cancelledAt,
    });
    expect(result).toEqual({ sent: false, reason: "not_cancelled" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("suppressed recipient is not sent a cancellation confirmation", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 60_000;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() + 20 * DAY_MS,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("emailSuppressions", {
        normalizedEmail: EMAIL,
        reason: "bounce",
        suppressedAt: Date.now(),
      });
    });

    const result = await t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "cancellation_confirm",
      episodeAt: cancelledAt,
    });
    expect(result).toEqual({ sent: false, reason: "suppressed" });
    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("send action re-reads after the uncapped pacing wait (PR #7328 review)", async () => {
    // Eligibility is checked, then reserveResendSlot can sleep for an
    // uncapped backlog. A resume during that wait must not send the
    // pre-wait "your access continues until <date>" snapshot.
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 60_000;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() + 20 * DAY_MS,
    });

    const parkedUntil = Date.now() + 1_500;
    await t.run(async (ctx) => {
      await ctx.db.insert("counters", {
        name: RESEND_SLOT_COUNTER,
        value: parkedUntil,
      });
    });

    const sendPromise = t.action(internal.payments.subscriptionEmails.sendDunningEmail, {
      dodoSubscriptionId: SUB_ID,
      step: "cancellation_confirm",
      episodeAt: cancelledAt,
    });

    // The action has reserved its slot once the cursor moves past the park.
    await vi.waitFor(async () => {
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("counters")
          .withIndex("by_name", (q) => q.eq("name", RESEND_SLOT_COUNTER))
          .unique(),
      );
      expect(row?.value).toBeGreaterThan(parkedUntil);
    });

    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
        .unique();
      if (!sub) throw new Error("missing subscription");
      await ctx.db.patch(sub._id, { status: "active" });
    });

    const result = await sendPromise;
    expect(result).toEqual({ sent: false, reason: "not_cancelled" });
    expect(resendSends(fetchMock)).toHaveLength(0);
    expect(await ledgerRows(t)).toHaveLength(0);
  });
});

describe("cancellation_confirm × winback share an episode key (#7314)", () => {
  test("a confirmed cancellation still gets its winback 30 days later", async () => {
    // Both steps anchor on the SAME episode (`subscriptions.cancelledAt`), so
    // a ledger pre-check that dropped the `step` from its key would read the
    // confirmation row as "winback already sent" and silently kill winback
    // for every canceller. Only the step-scoped index keeps them independent.
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    // Access must have ended 30-60 days ago: the scan ranges on
    // currentPeriodEnd, not cancelledAt.
    const cancelledAt = Date.now() - (WINBACK_MIN_AGE_MS + 40 * DAY_MS);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() - (WINBACK_MIN_AGE_MS + 5 * DAY_MS),
    });
    // The confirmation this subscriber received the day they cancelled.
    await t.run(async (ctx) => {
      await ctx.db.insert("dunningEmails", {
        dodoSubscriptionId: SUB_ID,
        step: "cancellation_confirm",
        episodeAt: cancelledAt,
        email: EMAIL,
        sentAt: cancelledAt,
      });
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("access has ended");
    expect(await ledgerRows(t)).toHaveLength(2);
  });
});

describe("cancellation confirmation copy (#7314)", () => {
  test("formats the access-end date in UTC, not the server timezone", () => {
    // A period ending just after midnight UTC must not print the previous
    // day. This date is the whole payload of the email — printing it a day
    // early is the same customer-facing failure as not sending it.
    expect(formatAccessEndDate(Date.parse("2026-09-28T00:30:00Z"))).toBe("28 September 2026");
    expect(formatAccessEndDate(Date.parse("2026-09-28T23:45:00Z"))).toBe("28 September 2026");
    expect(formatAccessEndDate(Date.parse("2026-01-01T00:00:00Z"))).toBe("1 January 2026");
    expect(formatAccessEndDate(Date.parse("2026-12-31T23:59:59Z"))).toBe("31 December 2026");
  });

  test("copy stays plan-neutral so API subscribers aren't told about Pro features", () => {
    // This step fires for EVERY plan key. The winback template names Pro
    // features unconditionally; this one must not copy that, or an
    // api_starter canceller is told their "briefs and WM Analyst" continue.
    const { subject, html } = buildCancellationConfirmEmail(
      "API Starter (Monthly)",
      "https://www.worldmonitor.app/dashboard",
      Date.parse("2026-09-28T19:01:10Z"),
    );
    expect(subject).toContain("API Starter (Monthly)");
    expect(subject).toContain("28 September 2026");
    expect(html).toContain("28 September 2026");
    for (const proOnly of ["WM Analyst", "Pro panels", "briefs"]) {
      expect(html).not.toContain(proOnly);
    }
    // And it must not claim the account drops to free — the canceller may
    // hold another covering subscription.
    expect(html).not.toContain("free tier");
  });

  test("falls back to a dateless phrase rather than printing an invalid date", () => {
    const { subject, html } = buildCancellationConfirmEmail(
      "Pro (Monthly)",
      "https://www.worldmonitor.app/dashboard",
    );
    expect(subject).toContain("until the end of your paid period");
    expect(html).toContain("until the end of your paid period");
    expect(subject).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  test("the lifecycle builder delegates cancellation copy to the copy module", () => {
    const accessUntil = Date.parse("2026-09-28T19:01:10Z");
    expect(
      buildDunningEmail(
        "cancellation_confirm",
        "Pro (Monthly)",
        "https://www.worldmonitor.app/dashboard",
        accessUntil,
      ),
    ).toEqual(
      buildCancellationConfirmEmail(
        "Pro (Monthly)",
        "https://www.worldmonitor.app/dashboard",
        accessUntil,
      ),
    );
  });
});

describe("cancellation confirmation is durably retried (#7328 review)", () => {
  test("a confirmation that never landed is re-queued by the daily scan", async () => {
    // The failure this covers: sendEmail throws on a transient Resend error
    // BEFORE the ledger write, and internalActions are not auto-retried. The
    // webhook only enqueues on the enteringCancelled transition, so without a
    // scan sweep that customer's confirmation is lost permanently — the exact
    // silence this whole PR exists to remove.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T10:00:00Z"));
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: Date.now() - 2 * 3600_000,
      currentPeriodEnd: Date.parse("2026-09-28T19:01:10Z"),
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.html).toContain("28 September 2026");
    expect(await ledgerRows(t)).toHaveLength(1);
  });

  test("a confirmation skipped because the webhook-time key is missing is recovered by the daily scan", async () => {
    // The webhook only enqueues when RESEND_API_KEY is set. A missing key at
    // cancellation time leaves a cancelled, still-covering row with no
    // scheduled send and no ledger — the scan sweep is the recovery path.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T10:00:00Z"));
    delete process.env.RESEND_API_KEY;
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const periodEnd = Date.parse("2026-09-28T19:01:10Z");
    await seedSub(t, {
      status: "active",
      currentPeriodEnd: periodEnd,
      updatedAt: Date.now() - 5000,
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_cancel_no_key",
      eventType: "subscription.cancelled",
      rawPayload: {
        data: { subscription_id: SUB_ID, customer: { email: EMAIL } },
      },
      timestamp: Date.now(),
    });

    const scheduledAtWebhook = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduledAtWebhook).toHaveLength(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(0);
    expect(await ledgerRows(t)).toHaveLength(0);

    process.env.RESEND_API_KEY = "re_test";
    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = resendSends(fetchMock);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.html).toContain("28 September 2026");
    expect(sends[0]!.subject).toContain("28 September 2026");
    expect(await ledgerRows(t)).toHaveLength(1);
  });

  test("the scan does not re-send a confirmation already in the ledger", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const cancelledAt = Date.now() - 2 * 3600_000;
    await seedSub(t, {
      status: "cancelled",
      cancelledAt,
      currentPeriodEnd: Date.now() + 20 * DAY_MS,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("dunningEmails", {
        dodoSubscriptionId: SUB_ID,
        step: "cancellation_confirm",
        episodeAt: cancelledAt,
        email: EMAIL,
        sentAt: cancelledAt,
      });
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(resendSends(fetchMock)).toHaveLength(0);
    expect(await ledgerRows(t)).toHaveLength(1);
  });

  test("an old paid-through cancellation is not swept — first deploy must not mass-mail", async () => {
    // An annual subscriber who cancelled months ago is still paid through, so
    // an unbounded sweep would mail every historic canceller on the first tick
    // after deploy. The retry window is a retry window, not a backfill (same
    // reasoning as WINBACK_MAX_AGE_MS).
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: Date.now() - 30 * DAY_MS,
      currentPeriodEnd: Date.now() + 300 * DAY_MS,
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(resendSends(fetchMock)).toHaveLength(0);
    expect(await ledgerRows(t)).toHaveLength(0);
  });

  test("a legacy cancelled row with no cancelledAt is skipped, not anchored on updatedAt", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    await seedSub(t, {
      status: "cancelled",
      currentPeriodEnd: Date.now() + 20 * DAY_MS,
      updatedAt: Date.now() - 3600_000,
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(resendSends(fetchMock)).toHaveLength(0);
  });

  test("many old paid-through cancellations stay out of the retry query", async () => {
    // An annual who cancelled months ago remains currentPeriodEnd > now for
    // the rest of the year. A status+period-end collect() would re-read every
    // such row on every daily tick and can exceed Convex's per-transaction
    // read cap, starving all retries. The cancelledAt index must keep the
    // query at the three-day cohort regardless of how many historic
    // paid-through rows exist.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T10:00:00Z"));
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = mockResend();
    const t = convexTest(schema, modules);
    const now = Date.now();
    const historic = 200;
    await t.run(async (ctx) => {
      for (let i = 0; i < historic; i++) {
        await ctx.db.insert("subscriptions", {
          userId: `user_historic_${i}`,
          dodoSubscriptionId: `sub_historic_${i}`,
          dodoProductId: "pdt_test",
          planKey: "pro_annual",
          status: "cancelled",
          currentPeriodStart: now - 200 * DAY_MS,
          currentPeriodEnd: now + 160 * DAY_MS,
          cancelledAt: now - (30 + i) * DAY_MS,
          rawPayload: { subscription_id: `sub_historic_${i}`, customer: { email: EMAIL } },
          updatedAt: now - (30 + i) * DAY_MS,
        });
      }
    });
    await seedSub(t, {
      status: "cancelled",
      cancelledAt: now - 2 * 3600_000,
      currentPeriodEnd: now + 20 * DAY_MS,
    });

    const scan = await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    expect(scan.paidThroughCancelled).toBe(1);
    expect(scan.scheduled).toBe(1);
    expect(30 * DAY_MS).toBeGreaterThan(CANCELLATION_CONFIRM_RETRY_MAX_AGE_MS);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(resendSends(fetchMock)).toHaveLength(1);
    expect(await ledgerRows(t)).toHaveLength(1);
  });
});
