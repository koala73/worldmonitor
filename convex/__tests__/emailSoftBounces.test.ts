import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  SOFT_BOUNCE_SUPPRESS_THRESHOLD,
  SOFT_BOUNCE_WINDOW_MS,
} from "../emailSuppressions";
import { classifyBounce } from "../resendWebhookHandler";
import crons from "../crons";

const modules = import.meta.glob("../**/*.ts");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function strike(emailMessageId: string, occurredAt: number, email = "Full.Box@Example.com") {
  return {
    email,
    emailMessageId,
    bounceType: "Transient",
    bounceSubType: "MailboxFull",
    occurredAt,
    source: `test:${emailMessageId}`,
  };
}

async function suppressionsOf(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());
}

async function strikesOf(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("emailSoftBounces").collect());
}

describe("soft-bounce policy constants", () => {
  test("is 3 strikes in 30 days", () => {
    expect(SOFT_BOUNCE_SUPPRESS_THRESHOLD).toBe(3);
    expect(SOFT_BOUNCE_WINDOW_MS).toBe(30 * DAY);
  });
});

describe("classifyBounce", () => {
  test("Permanent and missing bounce data are hard", () => {
    expect(classifyBounce({ type: "Permanent", subType: "General" })).toBe("hard");
    expect(classifyBounce(undefined)).toBe("hard");
    expect(classifyBounce({})).toBe("hard");
    expect(classifyBounce({ type: "SomethingNew" })).toBe("hard");
  });

  test("Transient, Temporary and Undetermined are soft", () => {
    expect(classifyBounce({ type: "Transient", subType: "MailboxFull" })).toBe("soft");
    expect(classifyBounce({ type: "Transient", subType: "General" })).toBe("soft");
    expect(classifyBounce({ type: "temporary" })).toBe("soft");
    expect(classifyBounce({ type: "Undetermined", subType: "Undetermined" })).toBe("soft");
  });

  test("content-caused transient subtypes are ignored", () => {
    expect(classifyBounce({ type: "Transient", subType: "MessageTooLarge" })).toBe("ignore");
    expect(classifyBounce({ type: "Transient", subType: "ContentRejected" })).toBe("ignore");
    expect(classifyBounce({ type: "Transient", subType: "AttachmentRejected" })).toBe("ignore");
  });
});

describe("recordSoftBounce", () => {
  afterEach(() => vi.restoreAllMocks());

  test("suppresses on the third distinct soft bounce inside 30 days", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);

    const r1 = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW - 20 * DAY));
    const r2 = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m2", NOW - 10 * DAY));
    expect(r1).toEqual({ strikes: 1, suppressed: false, ignored: false });
    expect(r2).toEqual({ strikes: 2, suppressed: false, ignored: false });
    expect(await suppressionsOf(t)).toEqual([]);

    const r3 = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m3", NOW));
    expect(r3).toEqual({ strikes: 3, suppressed: true, ignored: false });
    const rows = await suppressionsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ normalizedEmail: "full.box@example.com", reason: "bounce" });
    expect(rows[0]!.source).toMatch(/^soft-bounce:3-in-30d/);
    // Strikes are consumed once they become a suppression.
    expect(await strikesOf(t)).toEqual([]);

    // The suppression blocks both transactional and marketing mail.
    expect(await t.query(internal.emailSuppressions.isEmailSuppressed, {
      email: "full.box@example.com",
      purpose: "transactional",
    })).toBe(true);
  });

  test("a repeated event for the same message is one strike (webhook retries)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("same-message", NOW));
    }
    expect(await strikesOf(t)).toHaveLength(1);
    expect(await suppressionsOf(t)).toEqual([]);
  });

  test("a bounce older than the window is ignored, never a strike", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW - 2 * DAY));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m2", NOW - DAY));
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("old", NOW - 31 * DAY));
    expect(r).toEqual({ strikes: 2, suppressed: false, ignored: true });
    expect(await strikesOf(t)).toHaveLength(2);
    expect(await suppressionsOf(t)).toEqual([]);
  });

  test("strikes that age out of the window are pruned", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW - 29 * DAY));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m2", NOW - 28 * DAY));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 3 * DAY);
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m3", NOW + 3 * DAY));
    expect(r).toEqual({ strikes: 1, suppressed: false, ignored: false });
    expect(await strikesOf(t)).toHaveLength(1);
    expect(await suppressionsOf(t)).toEqual([]);
  });

  test("addresses are counted independently and case-insensitively", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("a1", NOW, "a@example.com"));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("a2", NOW, "A@EXAMPLE.COM"));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("b1", NOW, "b@example.com"));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("b2", NOW, "b@example.com"));
    expect(await suppressionsOf(t)).toEqual([]);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("a3", NOW, " a@example.com "));
    const rows = await suppressionsOf(t);
    expect(rows.map((r) => r.normalizedEmail)).toEqual(["a@example.com"]);
    expect(await strikesOf(t)).toHaveLength(2);
  });

  test("upgrades a broadcast-only unsubscribe to a bounce suppression", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "full.box@example.com",
      reason: "unsubscribe",
    });
    for (const id of ["m1", "m2", "m3"]) {
      await t.mutation(internal.emailSuppressions.recordSoftBounce, strike(id, NOW));
    }
    const rows = await suppressionsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("bounce");
  });

  test("does nothing for an address that is already hard-suppressed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "full.box@example.com",
      reason: "complaint",
    });
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW));
    expect(r).toEqual({ strikes: 0, suppressed: true, ignored: true });
    expect(await strikesOf(t)).toEqual([]);
    expect((await suppressionsOf(t))[0]!.reason).toBe("complaint");
  });

  test("a delivery clears the strikes before it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW - 3 * DAY));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m2", NOW - 2 * DAY));
    expect(await t.mutation(internal.emailSuppressions.clearSoftBounces, {
      email: "FULL.BOX@example.com",
      deliveredAt: NOW - DAY,
    })).toBe(2);
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m3", NOW));
    expect(r).toEqual({ strikes: 1, suppressed: false, ignored: false });
    expect(await suppressionsOf(t)).toEqual([]);
  });

  test("a late, older delivery keeps newer strikes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW - 2 * DAY));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m2", NOW - DAY));
    // Delivered three days ago, but its webhook arrives only now.
    expect(await t.mutation(internal.emailSuppressions.clearSoftBounces, {
      email: "full.box@example.com",
      deliveredAt: NOW - 3 * DAY,
    })).toBe(0);
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m3", NOW));
    expect(r).toEqual({ strikes: 3, suppressed: true, ignored: false });
  });

  test("a late bounce older than the last delivery cannot restart the count", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW - 3 * DAY));
    await t.mutation(internal.emailSuppressions.clearSoftBounces, {
      email: "full.box@example.com",
      deliveredAt: NOW - DAY,
    });
    // Bounced before that delivery, but the webhook arrives afterwards.
    const late = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m0", NOW - 2 * DAY));
    expect(late).toEqual({ strikes: 0, suppressed: false, ignored: true });
    expect(await strikesOf(t)).toEqual([]);
  });

  test("a delivery before the first bounce still rejects older failures", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.clearSoftBounces, {
      email: "healthy@example.com",
      deliveredAt: NOW,
    });
    const late = await t.mutation(internal.emailSuppressions.recordSoftBounce,
      strike("late-first", NOW - DAY, "healthy@example.com"));
    expect(late).toEqual({ strikes: 0, suppressed: false, ignored: true });
    expect(await strikesOf(t)).toEqual([]);
  });

  test("suppression removes the reset mark too", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m0", NOW - 5 * DAY));
    await t.mutation(internal.emailSuppressions.clearSoftBounces, {
      email: "full.box@example.com",
      deliveredAt: NOW - 4 * DAY,
    });
    for (const [i, id] of ["m1", "m2", "m3"].entries()) {
      await t.mutation(internal.emailSuppressions.recordSoftBounce, strike(id, NOW - (3 - i) * DAY));
    }
    expect(await suppressionsOf(t)).toHaveLength(1);
    const resets = await t.run(async (ctx) => await ctx.db.query("emailSoftBounceResets").collect());
    expect(resets).toEqual([]);
  });
});

describe("soft-bounce retention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("schedules the retention mutation daily", () => {
    expect(crons.crons["email-soft-bounce-prune"]).toMatchObject({
      name: "emailSuppressions:pruneSoftBounceData",
      schedule: { type: "daily" },
    });
  });

  test("removes expired tracking data without deleting window-boundary evidence or suppressions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const cutoff = NOW - SOFT_BOUNCE_WINDOW_MS;
    await t.run(async (ctx) => {
      for (const occurredAt of [cutoff - 1, cutoff, NOW]) {
        await ctx.db.insert("emailSoftBounces", {
          normalizedEmail: "full.box@example.com",
          emailMessageId: `m-${occurredAt}`,
          bounceType: "Transient",
          occurredAt,
        });
        await ctx.db.insert("emailSoftBounceResets", {
          normalizedEmail: `delivered-${occurredAt}@example.com`,
          lastDeliveredAt: occurredAt,
        });
      }
    });
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "suppressed@example.com", reason: "bounce",
    });
    const result = await t.mutation(internal.emailSuppressions.pruneSoftBounceData, {});
    expect(result).toEqual({ strikesDeleted: 1, resetsDeleted: 1, rescheduled: false });
    expect((await strikesOf(t)).map((row) => row.occurredAt).sort()).toEqual([cutoff, NOW]);
    const resets = await t.run((ctx) => ctx.db.query("emailSoftBounceResets").collect());
    expect(resets.map((row) => row.lastDeliveredAt).sort()).toEqual([cutoff, NOW]);
    expect(await suppressionsOf(t)).toHaveLength(1);
  });

  test("bounds each batch and drains the remaining backlog through the scheduler", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("emailSoftBounces", {
          normalizedEmail: `old-${i}@example.com`,
          emailMessageId: `old-${i}`,
          bounceType: "Transient",
          occurredAt: NOW - 31 * DAY,
        });
        await ctx.db.insert("emailSoftBounceResets", {
          normalizedEmail: `old-${i}@example.com`,
          lastDeliveredAt: NOW - 31 * DAY,
        });
      }
    });
    const first = await t.mutation(internal.emailSuppressions.pruneSoftBounceData, {});
    expect(first).toEqual({ strikesDeleted: 500, resetsDeleted: 500, rescheduled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await strikesOf(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("emailSoftBounceResets").collect())).toEqual([]);
  });
});
