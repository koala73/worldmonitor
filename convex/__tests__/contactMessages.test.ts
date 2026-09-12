import { convexTest } from "convex-test";
import { expect, test, describe, afterEach, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { submit } from "../contactMessages";
import { submitContact } from "../../server/worldmonitor/leads/v1/submit-contact";

const modules = import.meta.glob("../**/*.ts");

describe("contact HTTP storage boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const payload = { name: "Ada", email: "ada@example.com", source: "test" };
  const request = (secret?: string, body = JSON.stringify(payload)) => ({
    method: "POST",
    headers: secret ? { "x-convex-shared-secret": secret } : {},
    body,
  });

  test.each([undefined, "wrong"])("rejects secret %s before writing", async (secret) => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "synthetic-secret");
    const t = convexTest(schema, modules);
    expect((await t.fetch("/leads/submit-contact", request(secret))).status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("contactMessages").collect())).toHaveLength(0);
  });

  test("fails closed when the server secret is absent", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "");
    const t = convexTest(schema, modules);
    expect((await t.fetch("/leads/submit-contact", request())).status).toBe(401);
  });

  test("authenticated route writes through the real mutation and retains email throttle", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "synthetic-secret");
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) {
      const response = await t.fetch("/leads/submit-contact", request("synthetic-secret"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "sent" });
    }
    expect((await t.fetch("/leads/submit-contact", request("synthetic-secret"))).status).toBe(429);
    expect(await t.run((ctx) => ctx.db.query("contactMessages").collect())).toHaveLength(5);
  });

  test("retains corporate email rejection", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "synthetic-secret");
    const t = convexTest(schema, modules);
    const body = JSON.stringify({ ...payload, email: "ada@gmail.com" });
    expect((await t.fetch("/leads/submit-contact", request("synthetic-secret", body))).status).toBe(422);
    expect(await t.run((ctx) => ctx.db.query("contactMessages").collect())).toHaveLength(0);
  });

  test.each(["null", "[]", "{", '{"name": 1}'])("rejects malformed body %s", async (body) => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "synthetic-secret");
    const t = convexTest(schema, modules);
    expect((await t.fetch("/leads/submit-contact", request("synthetic-secret", body))).status).toBe(400);
  });

  test("edge handler reaches the real HTTP action and database with mocked providers", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "synthetic-secret");
    vi.stubEnv("CONVEX_SITE_URL", "https://synthetic.convex.site");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "synthetic-turnstile");
    vi.stubEnv("RESEND_API_KEY", "synthetic-resend");
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("turnstile")) return Response.json({ success: true });
      if (url === "https://synthetic.convex.site/leads/submit-contact") {
        return t.fetch("/leads/submit-contact", init);
      }
      expect(url).toBe("https://api.resend.com/emails");
      expect(await t.run((ctx) => ctx.db.query("contactMessages").collect())).toHaveLength(1);
      return Response.json({ id: "synthetic-email" });
    }));
    const response = await submitContact({
      request: new Request("https://worldmonitor.app/api/leads/v1/submit-contact"),
      pathParams: {}, headers: {},
    }, {
      ...payload, organization: "Example", phone: "+1 555 123 4567",
      message: "Hello", website: "", turnstileToken: "synthetic-token",
    });
    expect(response).toEqual({ status: "sent", emailSent: true });
  });
});

describe("contactMessages.submit", () => {
  test("contact writes are internal so anonymous clients cannot bypass the edge gates", () => {
    const fn = submit as unknown as { isInternal?: boolean; isPublic?: boolean };
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).toBeUndefined();
  });
  test("stores a valid submission", async () => {
    const t = convexTest(schema, modules);
    const res = await t.mutation(internal.contactMessages.submit, {
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
      t.mutation(internal.contactMessages.submit, {
        name: "Ada",
        email: "not-an-email",
        source: "test",
      }),
    ).rejects.toThrow(/email/i);
  });

  test.each(["user@gmail.com", "user@mailinator.com"])(
    "rejects non-corporate email %s with a structured policy error",
    async (email) => {
      const t = convexTest(schema, modules);
      const error = await t
        .mutation(internal.contactMessages.submit, {
          name: "Ada",
          email,
          source: "test",
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(Error);
      const rawData = (error as { data?: unknown }).data;
      const data = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      expect(data).toMatchObject({
        kind: "FREE_EMAIL_NOT_ALLOWED",
      });
    },
  );

  test("rejects empty name", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.contactMessages.submit, {
        name: "   ",
        email: "ada@example.com",
        source: "test",
      }),
    ).rejects.toThrow(/name/i);
  });

  test("clips oversized fields", async () => {
    const t = convexTest(schema, modules);
    const huge = "x".repeat(10_000);
    await t.mutation(internal.contactMessages.submit, {
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
    await t.mutation(internal.contactMessages.submit, {
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
    await t.mutation(internal.contactMessages.submit, {
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
      await t.mutation(internal.contactMessages.submit, args);
    }
    await expect(t.mutation(internal.contactMessages.submit, args)).rejects.toThrow(
      /Too many|rate_limited/i,
    );
  });

  test("normalizes email casing for the rate-limit bucket", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.contactMessages.submit, {
        name: "Ada",
        email: i % 2 === 0 ? "ada@example.com" : "ADA@Example.com",
        source: "test",
      });
    }
    await expect(
      t.mutation(internal.contactMessages.submit, {
        name: "Ada",
        email: "Ada@EXAMPLE.com",
        source: "test",
      }),
    ).rejects.toThrow(/Too many|rate_limited/i);
  });
});
