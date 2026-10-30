// @vitest-environment node

/**
 * #5379 — `validateUserApiKey` trusted two things it never checked.
 *
 * Gap 2 (state corruption / elevation of privilege): the value returned by
 *   `cachedFetchJson<UserKeyResult>` was CAST, never validated. A poisoned
 *   cache entry or a Convex response shape drift (e.g. `{}`) produced a truthy
 *   object, and every caller — server/gateway.ts, server/_shared/premium-check.ts,
 *   api/mcp/auth.ts — treats truthy as "authenticated principal", reading
 *   `.userId` as `undefined`.
 *
 * Gap 3 (malformed-key amplification): the only guard was `startsWith('wm_')`,
 *   so `wm_x` reached SHA-256, the Redis cache, and the Convex backend. The
 *   real key contract is `wm_` + 40 lowercase hex, already enforced by the
 *   sibling module api/_user-api-key.js. The two modules disagreed.
 *
 * Plan 2026-10-25-001 U3 (KTD3, KTD8) sharpened Gap 2: the cache entry is
 *   versioned and carries an explicit `keyKind`. Only a CURRENT entry is a
 *   principal from the cache. An object-shaped hit that is not current — a
 *   pre-version shape, a missing/unknown kind, a poisoned object — is
 *   re-validated at Convex and rewritten, never trusted and never a 401.
 *   Non-object hits are discarded as before.
 *
 * The amplification assertions deliberately check that the backend was NEVER
 * INVOKED — a null return alone would still have burned a Convex round-trip.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const cachedFetchJson = vi.fn();
const deleteRedisKey = vi.fn();
const readCachedJson = vi.fn();
const setCachedJson = vi.fn();
vi.mock("../_shared/redis", () => ({
  cachedFetchJson: (...a: unknown[]) => cachedFetchJson(...a),
  deleteRedisKey: (...a: unknown[]) => deleteRedisKey(...a),
  readCachedJson: (...a: unknown[]) => readCachedJson(...a),
  setCachedJson: (...a: unknown[]) => setCachedJson(...a),
}));

import { validateUserApiKey } from "../_shared/user-api-key";

const VALID_KEY = `wm_${"a1b2c3d4e5".repeat(4)}`; // wm_ + 40 lowercase hex
const VALID_RESULT = { v: 2, userId: "user_123", keyId: "k1", name: "prod", keyKind: "api" };
const CONVEX_ROW = { id: "k_convex", userId: "u_convex", name: "prod", keyKind: "api" };
const CONVEX_ENTRY = { v: 2, userId: "u_convex", keyId: "k_convex", name: "prod", keyKind: "api" };

const ORIGINAL_ENV = {
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  CONVEX_SERVER_SHARED_SECRET: process.env.CONVEX_SERVER_SHARED_SECRET,
};

/** Route the validator's Convex re-validation to a scripted answer. */
function stubConvex(payload: unknown) {
  process.env.CONVEX_SITE_URL = "https://convex.test";
  process.env.CONVEX_SERVER_SHARED_SECRET = "secret";
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("https://convex.test/api/internal-validate-api-key");
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  cachedFetchJson.mockReset();
  deleteRedisKey.mockReset();
  readCachedJson.mockReset().mockResolvedValue({ status: "miss" });
  setCachedJson.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("validateUserApiKey — positive control", () => {
  test("a canonical key with a current entry resolves to the principal", async () => {
    cachedFetchJson.mockResolvedValue(VALID_RESULT);
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(VALID_RESULT);
    expect(cachedFetchJson).toHaveBeenCalledTimes(1);
  });

  test("a legitimate negative-cache hit (null) stays null, not an error", async () => {
    cachedFetchJson.mockResolvedValue(null);
    await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
    expect(cachedFetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("Gap 2 — non-object cache payloads are discarded without Convex", () => {
  const POISONED: Array<[string, unknown]> = [
    ["array", []],
    ["bare string", "string"],
    ["number", 7],
    ["true", true],
  ];

  for (const [label, payload] of POISONED) {
    test(`${label} → null`, async () => {
      const fetchMock = stubConvex(CONVEX_ROW);
      cachedFetchJson.mockResolvedValue(payload);
      await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

/**
 * An object-shaped hit that is not a current entry is never a principal on
 * its own. It is also never a 401: the request is re-validated at Convex, and
 * Convex's answer — not the entry — is what the caller gets. Both directions
 * are asserted so a regression toward "trust" or toward "deny" fails.
 */
describe("Gap 2 / KTD8 — non-current object hits are re-validated at Convex", () => {
  const NOT_CURRENT: Array<[string, unknown]> = [
    ["empty object", {}],
    ["empty userId", { userId: "" }],
    ["numeric userId", { userId: 123 }],
    ["null userId", { userId: null }],
    ["userId is an object", { userId: {} }],
    ["userId only on the prototype", Object.create({ userId: "u1" })],
    ["pre-version Convex row cached by the gateway (id, not keyId)", { id: "j97xyz", userId: "u1", name: "prod" }],
    ["pre-version api/_user-api-key.js write ({userId, keyId, name})", { userId: "u1", keyId: "j97xyz", name: "prod" }],
    ["userId only", { userId: "u1" }],
    ["versioned but no keyKind", { v: 2, userId: "u1", keyId: "j97xyz" }],
    ["versioned with an unknown keyKind", { v: 2, userId: "u1", keyId: "j97xyz", keyKind: "enterprise" }],
    ["current shape under a stale version", { v: 1, userId: "u1", keyId: "j97xyz", keyKind: "api" }],
  ];

  for (const [label, payload] of NOT_CURRENT) {
    test(`${label}: Convex says unknown → null, entry dropped`, async () => {
      const fetchMock = stubConvex(null);
      readCachedJson.mockResolvedValue({ status: "hit", value: payload });
      await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cachedFetchJson).not.toHaveBeenCalled();
      expect(deleteRedisKey).toHaveBeenCalledWith(expect.stringMatching(/^user-api-key:[a-f0-9]{64}$/));
    });

    test(`${label}: Convex says api → Convex's principal, entry rewritten`, async () => {
      const fetchMock = stubConvex(CONVEX_ROW);
      readCachedJson.mockResolvedValue({ status: "hit", value: payload });
      await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(CONVEX_ENTRY);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(setCachedJson).toHaveBeenCalledWith(expect.stringMatching(/^user-api-key:/), CONVEX_ENTRY, 60);
    });
  }

  test("a non-current object raced in behind the pre-read is re-validated the same way", async () => {
    const fetchMock = stubConvex(CONVEX_ROW);
    readCachedJson.mockResolvedValue({ status: "miss" });
    cachedFetchJson.mockResolvedValue({ userId: "u1" });
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(CONVEX_ENTRY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("KTD3 — only an explicit api kind is a generic principal", () => {
  test("a current desktop entry is null without touching Convex", async () => {
    const fetchMock = stubConvex(CONVEX_ROW);
    cachedFetchJson.mockResolvedValue({ ...VALID_RESULT, keyKind: "desktop" });
    await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Company Monitoring account-bound cache shape", () => {
  test("generic validation rejects an exact scoped binding from the shared cache", async () => {
    const fetchMock = stubConvex(CONVEX_ROW);
    const scoped = {
      v: 2,
      keyId: "j97xyz",
      userId: "u1",
      name: "monitoring",
      keyKind: "api",
      scopes: ["company_monitoring:read", "company_monitoring:write"],
      companyMonitoringAccountId: "cm_account_01K1A2B3C4D5E6F7G8H9J0K1M2",
    };
    cachedFetchJson.mockResolvedValue(scoped);
    await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
    expect(cachedFetchJson).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  for (const [label, binding] of [
    ["scopes without account", { scopes: ["company_monitoring:read"] }],
    ["account without scopes", { companyMonitoringAccountId: "cm_account_x" }],
    ["unknown scope", { scopes: ["company_monitoring:admin"], companyMonitoringAccountId: "cm_account_x" }],
    ["duplicate scope", { scopes: ["company_monitoring:read", "company_monitoring:read"], companyMonitoringAccountId: "cm_account_x" }],
  ] as const) {
    test(`${label} is not current: re-validated, and Convex's null wins`, async () => {
      const fetchMock = stubConvex(null);
      cachedFetchJson.mockResolvedValue({ v: 2, userId: "u1", keyId: "j97xyz", keyKind: "api", ...binding });
      await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
});

describe("Gap 3 — malformed keys are rejected without amplification", () => {
  const MALFORMED: Array<[string, string]> = [
    ["too short (wm_x)", "wm_x"],
    ["39 hex", `wm_${"a".repeat(39)}`],
    ["41 hex", `wm_${"a".repeat(41)}`],
    ["40 UPPERCASE hex", `wm_${"A1B2C3D4E5".repeat(4)}`],
    ["40 non-hex chars", `wm_${"z".repeat(40)}`],
    ["prefix only", "wm_"],
    ["trailing whitespace", `wm_${"a".repeat(40)} `],
    ["leading whitespace", ` wm_${"a".repeat(40)}`],
    ["embedded newline", `wm_${"a".repeat(40)}\n`],
    ["64 hex (enterprise-shaped, not a user key)", `wm_${"a".repeat(64)}`],
  ];

  for (const [label, key] of MALFORMED) {
    test(`${label} → null AND no hashing, no cache, no Convex call`, async () => {
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        cachedFetchJson.mockResolvedValue(VALID_RESULT); // would authenticate if reached
        await expect(validateUserApiKey(key)).resolves.toBeNull();
        expect(cachedFetchJson).not.toHaveBeenCalled();
        expect(readCachedJson).not.toHaveBeenCalled();
        expect(digest).not.toHaveBeenCalled();
      } finally {
        digest.mockRestore();
      }
    });
  }

  test("non-wm_ and empty inputs still short-circuit", async () => {
    cachedFetchJson.mockResolvedValue(VALID_RESULT);
    for (const key of ["", "sk_live_abc", "wms_session"]) {
      await expect(validateUserApiKey(key)).resolves.toBeNull();
    }
    expect(cachedFetchJson).not.toHaveBeenCalled();
  });
});

describe("format contract agrees with the sibling module", () => {
  test("api/_user-api-key.js USER_API_KEY_RE and this module's regex are identical", async () => {
    const { readFileSync } = await import("node:fs");
    const extract = (path: string, name: string) => {
      const src = readFileSync(new URL(path, import.meta.url), "utf8");
      const m = src.match(new RegExp(`${name}\\s*=\\s*(/[^\\n]*?/)\\s*;`));
      if (!m) throw new Error(`${name} not found in ${path}`);
      return m[1];
    };
    expect(extract("../_shared/user-api-key.ts", "USER_API_KEY_RE")).toBe(
      extract("../../api/_user-api-key.js", "USER_API_KEY_RE"),
    );
  });
});
