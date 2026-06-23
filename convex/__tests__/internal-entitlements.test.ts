import { convexTest } from "convex-test";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const CONVEX_SECRET = "test-convex-secret-internal-entitlements-46chXX";
const USER_ID_SIGNING_SECRET = "test-user-id-signing-secret-internal-entitlements-2x5zW";
const USER_ID_SIGNATURE_HEADER = "x-convex-user-id-signature";
const USER_ID_SIGNATURE_PREFIX = "internal-entitlements:";
const USER_A = "user-test-entitlements";

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function userIdSignature(userId: string, secret = USER_ID_SIGNING_SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${USER_ID_SIGNATURE_PREFIX}${userId}`));
  return bytesToHex(sig);
}

async function validHeaders(userId = USER_A): Promise<Record<string, string>> {
  return {
    "x-convex-shared-secret": CONVEX_SECRET,
    [USER_ID_SIGNATURE_HEADER]: await userIdSignature(userId),
    "Content-Type": "application/json",
  };
}

describe("/api/internal-entitlements HTTP action", () => {
  let originalSecret: string | undefined;
  let originalUserIdSigningSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    originalUserIdSigningSecret = process.env.CONVEX_INTERNAL_ENTITLEMENTS_USER_ID_SIGNING_SECRET;
    process.env.CONVEX_SERVER_SHARED_SECRET = CONVEX_SECRET;
    process.env.CONVEX_INTERNAL_ENTITLEMENTS_USER_ID_SIGNING_SECRET = USER_ID_SIGNING_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CONVEX_SERVER_SHARED_SECRET;
    } else {
      process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
    if (originalUserIdSigningSecret === undefined) {
      delete process.env.CONVEX_INTERNAL_ENTITLEMENTS_USER_ID_SIGNING_SECRET;
    } else {
      process.env.CONVEX_INTERNAL_ENTITLEMENTS_USER_ID_SIGNING_SECRET = originalUserIdSigningSecret;
    }
  });

  test("happy path: valid secret + valid userId → 200 with free-tier defaults", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: await validHeaders(USER_A),
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
        [USER_ID_SIGNATURE_HEADER]: await userIdSignature(USER_A),
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
      headers: await validHeaders(USER_A),
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
      headers: await validHeaders(USER_A),
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
      headers: await validHeaders(USER_A),
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
      headers: await validHeaders(oversized),
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
      headers: await validHeaders(USER_A),
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_JSON");
  });

  test("missing userId signature → 401 UNAUTHORIZED", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: {
        "x-convex-shared-secret": CONVEX_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  test("signature for a different userId → 401 UNAUTHORIZED", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: {
        "x-convex-shared-secret": CONVEX_SECRET,
        [USER_ID_SIGNATURE_HEADER]: await userIdSignature("different-user"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  test("missing userId signing secret → 401 UNAUTHORIZED", async () => {
    delete process.env.CONVEX_INTERNAL_ENTITLEMENTS_USER_ID_SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: await validHeaders(USER_A),
      body: JSON.stringify({ userId: USER_A }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });
});
