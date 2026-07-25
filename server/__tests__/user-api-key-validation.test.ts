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
 * The amplification assertions deliberately check that the backend was NEVER
 * INVOKED — a null return alone would still have burned a Convex round-trip.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const cachedFetchJson = vi.fn();
const deleteRedisKey = vi.fn();
vi.mock("../_shared/redis", () => ({
  cachedFetchJson: (...a: unknown[]) => cachedFetchJson(...a),
  deleteRedisKey: (...a: unknown[]) => deleteRedisKey(...a),
}));

import { validateUserApiKey } from "../_shared/user-api-key";

const VALID_KEY = `wm_${"a1b2c3d4e5".repeat(4)}`; // wm_ + 40 lowercase hex
const VALID_RESULT = { userId: "user_123", keyId: "k1", name: "prod" };

beforeEach(() => {
  cachedFetchJson.mockReset();
  deleteRedisKey.mockReset();
});

describe("validateUserApiKey — positive control", () => {
  test("a canonical key with a conforming payload resolves to the principal", async () => {
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

describe("Gap 2 — non-conforming backend/cache payloads must not authenticate", () => {
  const POISONED: Array<[string, unknown]> = [
    ["empty object", {}],
    ["empty userId", { userId: "" }],
    ["numeric userId", { userId: 123 }],
    ["null userId", { userId: null }],
    ["array", []],
    ["bare string", "string"],
    ["number", 7],
    ["true", true],
    ["userId is an object", { userId: {} }],
    ["userId only on the prototype", Object.create({ userId: "u1" })],
  ];

  for (const [label, payload] of POISONED) {
    test(`${label} → null`, async () => {
      cachedFetchJson.mockResolvedValue(payload);
      await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
    });
  }
});

/**
 * The guard must require ONLY `userId`. Two producers write the shared
 * `user-api-key:<hash>` entry with different shapes, and Convex's
 * validateKeyByHash (convex/apiKeys.ts) returns `id` — NOT `keyId`. A guard
 * demanding `keyId: string` would 401 every fresh Convex validation in
 * production while every mock-shaped unit test stayed green.
 */
describe("Gap 2 — shapes that MUST still authenticate (fail-closed guard)", () => {
  const ACCEPTED: Array<[string, unknown]> = [
    ["real Convex validateKeyByHash row (id, not keyId)", { id: "j97xyz", userId: "u1", name: "prod" }],
    ["api/_user-api-key.js cache write ({userId, keyId, name})", { userId: "u1", keyId: "j97xyz", name: "prod" }],
    ["userId only", { userId: "u1" }],
    ["keyId/name undefined", { userId: "u1", keyId: undefined, name: undefined }],
  ];

  for (const [label, payload] of ACCEPTED) {
    test(`${label} → authenticates`, async () => {
      cachedFetchJson.mockResolvedValue(payload);
      await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(payload);
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
