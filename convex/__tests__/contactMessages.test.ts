import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

describe("contactMessages.submit", () => {
  test("stores a valid submission", async () => {
    const t = convexTest(schema, modules);
    const res = await t.mutation(api.contactMessages.submit, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      organization: "Analytical Engine Co",
      phone: "+44 20 7946 0000",
      message: "Interested in enterprise plan",
      source: "enterprise-contact",
    });
    expect(res.status).toBe("sent");

    const rows = await t.run((ctx) => ctx.db.query("contactMessages").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedEmail).toBe("ada@example.com");
    expect(rows[0].source).toBe("enterprise-contact");
  });

  test("rejects malformed email", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.contactMessages.submit, {
        name: "Ada",
        email: "not-an-email",
        source: "test",
      }),
    ).rejects.toThrow(/email/i);
  });

  test("rejects empty name", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.contactMessages.submit, {
        name: "   ",
        email: "ada@example.com",
        source: "test",
      }),
    ).rejects.toThrow(/name/i);
  });

  test("clips oversized fields", async () => {
    const t = convexTest(schema, modules);
    const huge = "x".repeat(10_000);
    await t.mutation(api.contactMessages.submit, {
      name: huge,
      email: "ada@example.com",
      organization: huge,
      phone: huge,
      message: huge,
      source: huge,
    });
    const rows = await t.run((ctx) => ctx.db.query("contactMessages").collect());
    expect(rows).toHaveLength(1);
    // Bounds: name 500, organization 500, phone 30, message 2000, source 100.
    expect(rows[0].name.length).toBe(500);
    expect(rows[0].organization!.length).toBe(500);
    expect(rows[0].phone!.length).toBe(30);
    expect(rows[0].message!.length).toBe(2000);
    expect(rows[0].source.length).toBe(100);
  });

  test("strips control characters from short fields (name/source)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.contactMessages.submit, {
      name: "Ada\u0000\nLovelace",
      email: "ada@example.com",
      source: "test\rline",
    });
    const rows = await t.run((ctx) => ctx.db.query("contactMessages").collect());
    expect(rows[0].name).toBe("AdaLovelace");
    expect(rows[0].source).toBe("testline");
  });

  test("preserves newlines and tabs in message but strips other controls", async () => {
    // Regression for the original P2: clip() stripped ALL C0 controls
    // including LF, collapsing multi-line enterprise-contact prose into
    // a single line. The message field must keep LF and TAB so operators
    // see the submission formatted the way the user typed it, while
    // NULs, CR, and other control bytes still get scrubbed.
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const NUL = String.fromCharCode(0);
    const TAB = String.fromCharCode(9);
    const input =
      "Line 1" + LF +
      "Line 2" + LF +
      TAB + "indented bullet" + LF +
      NUL + " NUL stripped" + CR + "CR stripped";
    const expected =
      "Line 1" + LF +
      "Line 2" + LF +
      TAB + "indented bullet" + LF +
      " NUL strippedCR stripped";

    const t = convexTest(schema, modules);
    await t.mutation(api.contactMessages.submit, {
      name: "Ada",
      email: "ada@example.com",
      message: input,
      source: "test",
    });
    const rows = await t.run((ctx) => ctx.db.query("contactMessages").collect());
    expect(rows[0].message).toBe(expected);
  });

  test("rate-limits more than 5 submissions per email per hour", async () => {
    const t = convexTest(schema, modules);
    const args = {
      name: "Ada",
      email: "ada@example.com",
      source: "test",
    };
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.contactMessages.submit, args);
    }
    await expect(t.mutation(api.contactMessages.submit, args)).rejects.toThrow(
      /Too many|rate_limited/i,
    );
  });

  test("normalizes email casing for the rate-limit bucket", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.contactMessages.submit, {
        name: "Ada",
        email: i % 2 === 0 ? "ada@example.com" : "ADA@Example.com",
        source: "test",
      });
    }
    await expect(
      t.mutation(api.contactMessages.submit, {
        name: "Ada",
        email: "Ada@EXAMPLE.com",
        source: "test",
      }),
    ).rejects.toThrow(/Too many|rate_limited/i);
  });
});
