import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  SOFT_BOUNCE_SUPPRESS_THRESHOLD,
  SOFT_BOUNCE_WINDOW_MS,
} from "../emailSuppressions";
import { classifyBounce } from "../resendWebhookHandler";

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
    expect(r1).toEqual({ strikes: 1, suppressed: false });
    expect(r2).toEqual({ strikes: 2, suppressed: false });
    expect(await suppressionsOf(t)).toEqual([]);

    const r3 = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m3", NOW));
    expect(r3).toEqual({ strikes: 3, suppressed: true });
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

  test("strikes older than 30 days fall out of the window and are pruned", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("old1", NOW - 45 * DAY));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("old2", NOW - 31 * DAY));

    // Both inserts were clamped to the window start, so advance past it.
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1);
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("new", NOW + 1));
    expect(r).toEqual({ strikes: 1, suppressed: false });
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
    expect(r).toEqual({ strikes: 0, suppressed: true });
    expect(await strikesOf(t)).toEqual([]);
    expect((await suppressionsOf(t))[0]!.reason).toBe("complaint");
  });

  test("clearSoftBounces resets the count after a delivery", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m1", NOW));
    await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m2", NOW));
    expect(await t.mutation(internal.emailSuppressions.clearSoftBounces, {
      email: "FULL.BOX@example.com",
    })).toBe(2);
    const r = await t.mutation(internal.emailSuppressions.recordSoftBounce, strike("m3", NOW));
    expect(r).toEqual({ strikes: 1, suppressed: false });
    expect(await suppressionsOf(t)).toEqual([]);
  });
});
