import { convexTest } from "convex-test";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const CONVEX_SECRET = "test-convex-secret-internal-entitlements-46chXX";
const USER_A = "user-test-entitlements";

function validHeaders(): Record<string, string> {
  return {
    "x-convex-shared-secret": CONVEX_SECRET,
    "Content-Type": "application/json",
  };
}

describe("/api/internal-entitlements HTTP action", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SERVER_SHARED_SECRET = CONVEX_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CONVEX_SERVER_SHARED_SECRET;
    } else {
      process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });

  test("happy path: valid secret + valid userId → 200 with free-tier defaults", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: validHeaders(),
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { planKey: string };
    expect(body.planKey).toBe("free");
  });

  test("missing secret header → 401 UNAUTHORIZED", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  test("empty secret header → 401 UNAUTHORIZED", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: {
        "x-convex-shared-secret": "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  test("wrong secret → 401 UNAUTHORIZED", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: {
        "x-convex-shared-secret": "wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  test("missing userId → 400 MISSING_USER_ID", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: validHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_USER_ID");
  });

  test("empty-string userId → 400 MISSING_USER_ID", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: validHeaders(),
      body: JSON.stringify({ userId: "" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_USER_ID");
  });

  test("non-string userId (number) → 400 MISSING_USER_ID", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: validHeaders(),
      body: JSON.stringify({ userId: 12345 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_USER_ID");
  });

  test("oversized userId (>256 chars) → 400 MISSING_USER_ID", async () => {
    const t = convexTest(schema, modules);
    const oversized = "u-".repeat(200); // 400 chars
    expect(oversized.length).toBeGreaterThan(256);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: validHeaders(),
      body: JSON.stringify({ userId: oversized }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_USER_ID");
  });

  test("invalid JSON body → 400 INVALID_JSON", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: validHeaders(),
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_JSON");
  });

  test.each([null, [], "not-an-object", 42, true])(
    "non-object JSON body (%j) → 400 INVALID_JSON",
    async (payload) => {
      const t = convexTest(schema, modules);
      const res = await t.fetch("/api/internal-entitlements", {
        method: "POST",
        headers: validHeaders(),
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("INVALID_JSON");
    },
  );
});
