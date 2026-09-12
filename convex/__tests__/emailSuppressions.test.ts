import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

describe("emailSuppressions", () => {
  test("suppress inserts a new suppression record", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.emailSuppressions.suppress, {
      email: "bounced@example.com",
      reason: "bounce",
      source: "test",
    });
    expect(id).toBeTruthy();
  });

  test("suppress is idempotent (returns existing ID on duplicate)", async () => {
    const t = convexTest(schema, modules);
    const id1 = await t.mutation(internal.emailSuppressions.suppress, {
      email: "bounced@example.com",
      reason: "bounce",
    });
    const id2 = await t.mutation(internal.emailSuppressions.suppress, {
      email: "bounced@example.com",
      reason: "complaint",
    });
    expect(id1).toEqual(id2);
  });

  test("keeps a delivery suppression when a broadcast unsubscribe follows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "opted.out@example.com",
      reason: "bounce",
      source: "resend-webhook:email_bounced",
    });
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "OPTED.OUT@example.com",
      reason: "unsubscribe",
      source: "resend-webhook:contact_unsubscribed",
    });

    let rows = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalizedEmail: "opted.out@example.com",
      reason: "bounce",
      source: "resend-webhook:email_bounced",
    });

    await t.mutation(internal.emailSuppressions.suppress, {
      email: "opted.out@example.com",
      reason: "complaint",
      source: "resend-webhook:email_complained",
    });
    rows = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows[0]).toMatchObject({
      reason: "bounce",
      source: "resend-webhook:email_bounced",
    });
  });

  test("suppress normalizes email (case + whitespace)", async () => {
    const t = convexTest(schema, modules);
    const id1 = await t.mutation(internal.emailSuppressions.suppress, {
      email: "  Test@EXAMPLE.com  ",
      reason: "bounce",
    });
    const id2 = await t.mutation(internal.emailSuppressions.suppress, {
      email: "test@example.com",
      reason: "bounce",
    });
    expect(id1).toEqual(id2);
  });

  test("isEmailSuppressed returns true for suppressed address", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "bad@example.com",
      reason: "bounce",
    });
    const result = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "bad@example.com", purpose: "transactional" },
    );
    expect(result).toBe(true);
  });

  test("isEmailSuppressed keeps a broadcast unsubscribe out of transactional mail only", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "opted.out@example.com",
      reason: "unsubscribe",
    });

    const transactional = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "opted.out@example.com", purpose: "transactional" },
    );
    const marketing = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "opted.out@example.com", purpose: "marketing" },
    );
    expect(transactional).toBe(false);
    expect(marketing).toBe(true);
  });

  test("upgrades a broadcast-only unsubscribe when delivery later fails", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "opted.out@example.com",
      reason: "unsubscribe",
    });
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "opted.out@example.com",
      reason: "complaint",
    });

    const rows = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows).toMatchObject([{ reason: "complaint" }]);
    const result = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "opted.out@example.com", purpose: "transactional" },
    );
    expect(result).toBe(true);
  });

  test("isEmailSuppressed returns false for non-suppressed address", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "good@example.com", purpose: "transactional" },
    );
    expect(result).toBe(false);
  });

  test("isEmailSuppressed is case-insensitive", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "Bad@Example.COM",
      reason: "complaint",
    });
    const result = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "bad@example.com", purpose: "transactional" },
    );
    expect(result).toBe(true);
  });

  test("bulkSuppress adds multiple and deduplicates", async () => {
    const t = convexTest(schema, modules);
    // Pre-suppress one
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "existing@example.com",
      reason: "bounce",
    });

    const result = await t.mutation(internal.emailSuppressions.bulkSuppress, {
      emails: [
        { email: "existing@example.com", reason: "bounce", source: "import" },
        { email: "new1@example.com", reason: "bounce", source: "import" },
        { email: "new2@example.com", reason: "complaint", source: "import" },
      ],
    });

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
  });

  test("bulkSuppress upgrades a broadcast unsubscribe to a delivery suppression", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "opted.out@example.com",
      reason: "unsubscribe",
    });

    const result = await t.mutation(internal.emailSuppressions.bulkSuppress, {
      emails: [{ email: "opted.out@example.com", reason: "bounce", source: "relay-import" }],
    });
    expect(result).toEqual({ added: 0, skipped: 0, upgraded: 1 });

    const rows = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows).toMatchObject([{ reason: "bounce", source: "relay-import" }]);
    expect(
      await t.query(internal.emailSuppressions.isEmailSuppressed, {
        email: "opted.out@example.com",
        purpose: "transactional",
      }),
    ).toBe(true);
  });

  test("remove deletes a suppression record", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "removeme@example.com",
      reason: "manual",
    });

    const removed = await t.mutation(internal.emailSuppressions.remove, {
      email: "removeme@example.com",
    });
    expect(removed).toBe(true);

    const stillSuppressed = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "removeme@example.com", purpose: "transactional" },
    );
    expect(stillSuppressed).toBe(false);
  });

  test("remove returns false for non-existent email", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.emailSuppressions.remove, {
      email: "doesnotexist@example.com",
    });
    expect(result).toBe(false);
  });
});

describe("registerInterest suppression integration", () => {
  test("register returns emailSuppressed=false for clean address", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(
      internal.registerInterest.register as any,
      {
        email: "clean@example.com",
        source: "test",
      },
    );
    expect(result.status).toBe("registered");
    expect(result.emailSuppressed).toBe(false);
  });

  test("register returns emailSuppressed=true for suppressed address", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.emailSuppressions.suppress, {
      email: "suppressed@example.com",
      reason: "bounce",
    });
    const result = await t.mutation(
      internal.registerInterest.register as any,
      {
        email: "suppressed@example.com",
        source: "test",
      },
    );
    expect(result.status).toBe("registered");
    expect(result.emailSuppressed).toBe(true);
  });
});
