import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import crons from "../crons";
import { PENDING_STALE_AFTER_MS } from "../accountDeletion/registry";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("the stalled-deletion reaper runs often enough to bound recovery near the stale window", () => {
  // A dropped continuation leaves the account anonymized, write-fenced and
  // still billing until something re-arms it. Worst-case recovery is the stale
  // window plus one reaper period, so the period must not dwarf the window: an
  // hourly tick made that up to ~70 minutes for a 10-minute window (#8495).
  const job = (crons as unknown as {
    crons: Record<string, { name: string; schedule: { type: string; minutes?: number } }>;
  }).crons["account-deletion-stalled-reaper"];
  expect(job?.name).toBe("accountDeletion/batches:reapStalledDeletions");
  expect(job?.schedule.type).toBe("interval");
  const periodMs = (job?.schedule.minutes ?? Infinity) * 60_000;
  expect(periodMs).toBeLessThanOrEqual(PENDING_STALE_AFTER_MS / 2);
});

const USER = "user_progress";
const STEP_ORDER: Array<Doc<"accountDeletions">["step"]> = [
  "follows", "personal", "grants", "anonymize", "email_keyed", "external", "complete",
];

test("every committed erase page makes progress, so the streak ladder bounds lifetime attempts", async () => {
  // markBatchFailed's ladder counts consecutive failures and advanceErase
  // clears it on every committed page (#8495 risk 3). That is only a lifetime
  // bound if a committed page can never be a no-op: then at most
  // MAX_BATCH_ATTEMPTS - 1 failures separate two pages, and the number of
  // pages is fixed by the fenced account's rows. This pins the premise.
  const t = convexTest(schema, modules);
  const deletionId: Id<"accountDeletions"> = await t.run(async (ctx) => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert("followedCountries", { userId: USER, country: `C${i}`, addedAt: now });
    }
    for (let i = 0; i < 150; i++) {
      await ctx.db.insert("userPreferences", {
        userId: USER, variant: `variant-${i}`, data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: now,
      });
    }
    await ctx.db.insert("notificationChannels", {
      userId: USER, channelType: "email", email: "p@example.test", verified: true, linkedAt: now,
    });
    for (let i = 0; i < 70; i++) {
      await ctx.db.insert("paymentEvents", {
        userId: USER, dodoPaymentId: `pay_${i}`, type: "charge", amount: 100, currency: "USD",
        status: "succeeded", rawPayload: {}, occurredAt: now,
      });
    }
    await ctx.db.insert("customers", {
      userId: USER, dodoCustomerId: "cus_progress", email: "p@example.test",
      normalizedEmail: "p@example.test", createdAt: now, updatedAt: now,
    });
    return ctx.db.insert("accountDeletions", {
      userId: USER, userIdHash: "c".repeat(64), source: "self", status: "pending",
      step: "follows", personalTableIndex: 0, verifiedEmail: "p@example.test",
      dodoSubscriptionIds: [], subscriptionDocIds: [], startedAt: now, updatedAt: now,
    });
  });

  const measure = async () => t.run(async (ctx) => {
    const row = (await ctx.db.get(deletionId))!;
    return {
      step: STEP_ORDER.indexOf(row.step),
      tableIndex: row.personalTableIndex ?? 0,
      rows: (await Promise.all([
        ctx.db.query("followedCountries").withIndex("by_user", (q) => q.eq("userId", USER)).collect(),
        ctx.db.query("userPreferences").withIndex("by_user_variant", (q) => q.eq("userId", USER)).collect(),
        ctx.db.query("notificationChannels").withIndex("by_user", (q) => q.eq("userId", USER)).collect(),
        ctx.db.query("customers").withIndex("by_userId", (q) => q.eq("userId", USER)).collect(),
        ctx.db.query("paymentEvents").withIndex("by_userId", (q) => q.eq("userId", USER)).collect(),
      ])).reduce((sum, rows) => sum + rows.length, 0),
    };
  });

  let before = await measure();
  let pages = 0;
  while (STEP_ORDER[before.step] !== "external") {
    await t.mutation(internal.accountDeletion.batches.advanceErase, { deletionId });
    pages += 1;
    const after = await measure();
    const progressed = after.step > before.step
      || (after.step === before.step && after.tableIndex > before.tableIndex)
      || (after.step === before.step && after.tableIndex === before.tableIndex && after.rows < before.rows);
    expect(progressed, `page ${pages} committed without progress: ${JSON.stringify({ before, after })}`)
      .toBe(true);
    before = after;
    expect(pages).toBeLessThan(100);
  }
  expect(before.rows).toBe(0);
});
