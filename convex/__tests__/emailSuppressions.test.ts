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
      { email: "bad@example.com" },
    );
    expect(result).toBe(true);
  });

  test("isEmailSuppressed returns false for non-suppressed address", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(
      internal.emailSuppressions.isEmailSuppressed,
      { email: "good@example.com" },
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
      { email: "bad@example.com" },
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
      { email: "removeme@example.com" },
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
