import { convexTest } from "convex-test";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const RELAY_SECRET = "test-relay-secret-fcq-r1-46-charsXXXXXXXXXXXX";
const USER_A = "user-tests-fcr-A";
const USER_B = "user-tests-fcr-B";

describe("/relay/followed-countries HTTP action", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.RELAY_SHARED_SECRET;
    process.env.RELAY_SHARED_SECRET = RELAY_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.RELAY_SHARED_SECRET;
    } else {
      process.env.RELAY_SHARED_SECRET = originalSecret;
    }
  });

  async function seedUserFollows(
    t: ReturnType<typeof convexTest>,
    userId: string,
    rows: Array<{ country: string; addedAt: number }>,
  ): Promise<void> {
    await t.run(async (ctx) => {
      for (const r of rows) {
        await ctx.db.insert("followedCountries", {
          userId,
          country: r.country,
          addedAt: r.addedAt,
        });
      }
    });
  }

  test("happy path: valid secret + userId with rows → {countries:[...]}", async () => {
    const t = convexTest(schema, modules);
    await seedUserFollows(t, USER_A, [
      { country: "US", addedAt: 1000 },
      { country: "GB", addedAt: 2000 },
    ]);

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { countries: string[] };
    expect(body).toEqual({ countries: ["US", "GB"] });
  });

  test("happy path empty: valid auth + user with no rows → {countries:[]}", async () => {
    const t = convexTest(schema, modules);
    // No seed for USER_B.

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_B }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { countries: string[] };
    expect(body).toEqual({ countries: [] });
  });

  test("invalid secret → 401 UNAUTHORIZED", async () => {
    const t = convexTest(schema, modules);
    await seedUserFollows(t, USER_A, [{ country: "US", addedAt: 1000 }]);

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  test("missing Authorization header → 401", async () => {
    const t = convexTest(schema, modules);

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
  });

  test("missing userId in body → 400", async () => {
    const t = convexTest(schema, modules);

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("userId required");
  });

  test("P2 #19 — empty-string userId → 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("userId required");
  });

  test("P2 #19 — non-string userId (number) → 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: 12345 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("userId required");
  });

  test("P2 #19 — oversized userId (>256 chars) → 400", async () => {
    const t = convexTest(schema, modules);
    const oversized = "u_".repeat(200); // 400 chars
    expect(oversized.length).toBeGreaterThan(256);
    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: oversized }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("userId required");
  });

  test("invalid JSON body → 400 INVALID_BODY", async () => {
    const t = convexTest(schema, modules);

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_BODY");
  });

  test("returns countries sorted by addedAt ascending (matches listFollowed convention)", async () => {
    const t = convexTest(schema, modules);
    // Insert out-of-order to verify the sort: GB (3000) FIRST, then US (1000), then JP (2000).
    await seedUserFollows(t, USER_A, [
      { country: "GB", addedAt: 3000 },
      { country: "US", addedAt: 1000 },
      { country: "JP", addedAt: 2000 },
    ]);

    const res = await t.fetch("/relay/followed-countries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { countries: string[] };
    expect(body.countries).toEqual(["US", "JP", "GB"]);
  });
});
