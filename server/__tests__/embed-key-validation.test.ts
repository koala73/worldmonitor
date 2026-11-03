// @vitest-environment node

/**
 * `wme_` exists so a credential that lives in a partner's PUBLIC HTML cannot
 * unlock the paid REST surface. That guarantee is only worth what the SHAPE
 * gates are worth: `server/gateway.ts` treats a validated `wm_` key with active
 * apiAccess as a trusted paid principal, so the two validators must reject each
 * other's credentials BEFORE any Convex round-trip, on the regex alone.
 *
 * These assertions therefore check that the backend was NEVER INVOKED — a null
 * return alone would still mean the credential reached the lookup path.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const cachedFetchJson = vi.fn();
const deleteRedisKey = vi.fn();
vi.mock("../_shared/redis", () => ({
  cachedFetchJson: (...a: unknown[]) => cachedFetchJson(...a),
  deleteRedisKey: (...a: unknown[]) => deleteRedisKey(...a),
}));

import { validateEmbedKey, isEmbedKeyUnavailableError, hasEmbedAccess } from "../_shared/embed-key";
import { validateUserApiKey } from "../_shared/user-api-key";

const VALID_EMBED_KEY = `wme_${"a1b2c3d4e5".repeat(4)}`; // wme_ + 40 lowercase hex
const VALID_USER_KEY = `wm_${"a1b2c3d4e5".repeat(4)}`; // wm_ + 40 lowercase hex
const VALID_RESULT = { userId: "user_123", keyId: "k1", name: "partner-site" };
const NOW = Date.now();

beforeEach(() => {
  cachedFetchJson.mockReset();
  deleteRedisKey.mockReset();
});

/**
 * The mint gate is `tier >= 1 && embedAccess && not lapsed`, evaluated in ONE
 * place. `convex/embedKeys.ts` calls the same function; these cases reach it
 * through the server-side re-export, so the re-export path is covered too.
 *
 * `embedAccess` must arrive MERGED. Fail-closed on `undefined` is what makes
 * merge-before-gate load-bearing rather than a nicety.
 */
describe("hasEmbedAccess", () => {
  const ent = (tier: number, embedAccess: boolean | undefined, validUntil: number) => ({
    features: { tier, embedAccess },
    validUntil,
  });
  const LIVE = NOW + 86_400_000;

  test("a live tier-1 (Pro) row may mint", () => {
    expect(hasEmbedAccess(ent(1, true, LIVE), NOW)).toBe(true);
  });

  test("a live tier-2 (API) row may mint", () => {
    expect(hasEmbedAccess(ent(2, true, LIVE), NOW)).toBe(true);
  });

  test("free (tier 0) may not, however long its validUntil runs", () => {
    expect(hasEmbedAccess(ent(0, false, LIVE), NOW)).toBe(false);
  });

  test("a LAPSED tier-1 row may not — paid once is not paid now", () => {
    expect(hasEmbedAccess(ent(1, true, NOW - 1), NOW)).toBe(false);
  });

  test("validUntil exactly at now still counts as live", () => {
    expect(hasEmbedAccess(ent(1, true, NOW), NOW)).toBe(true);
  });

  test("an UNMERGED row (embedAccess undefined) fails closed", () => {
    // A row written before the catalog field existed. The Convex mutation
    // merges catalog defaults precisely so this case never reaches the gate
    // for a real paid subscriber — but if one ever does, it denies.
    expect(hasEmbedAccess(ent(1, undefined, LIVE), NOW)).toBe(false);
    expect(hasEmbedAccess(ent(2, undefined, LIVE), NOW)).toBe(false);
  });

  test("both halves are required — neither alone admits", () => {
    expect(hasEmbedAccess(ent(0, true, LIVE), NOW)).toBe(false);
    expect(hasEmbedAccess(ent(1, false, LIVE), NOW)).toBe(false);
  });

  test("a missing entitlement fails closed", () => {
    expect(hasEmbedAccess(null, NOW)).toBe(false);
    expect(hasEmbedAccess(undefined, NOW)).toBe(false);
  });

  test("only a literal true admits — no truthiness", () => {
    expect(hasEmbedAccess({ features: { tier: 1, embedAccess: 1 as never }, validUntil: LIVE }, NOW)).toBe(false);
  });
});

describe("validateEmbedKey — positive control", () => {
  test("a canonical key with a conforming payload resolves to the owner", async () => {
    cachedFetchJson.mockResolvedValue(VALID_RESULT);
    await expect(validateEmbedKey(VALID_EMBED_KEY)).resolves.toEqual(VALID_RESULT);
    expect(cachedFetchJson).toHaveBeenCalledTimes(1);
  });

  test("it reads its own Redis namespace, never the user-api-key one", async () => {
    cachedFetchJson.mockResolvedValue(VALID_RESULT);
    await validateEmbedKey(VALID_EMBED_KEY);
    const cacheKey = cachedFetchJson.mock.calls[0]?.[0] as string;
    expect(cacheKey.startsWith("embed-key:")).toBe(true);
    expect(cacheKey.startsWith("user-api-key:")).toBe(false);
  });

  test("a legitimate negative-cache hit (null) stays null, not an error", async () => {
    cachedFetchJson.mockResolvedValue(null);
    await expect(validateEmbedKey(VALID_EMBED_KEY)).resolves.toBeNull();
    expect(cachedFetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("surface isolation — the two credentials never cross", () => {
  test("a wme_ key is rejected by validateUserApiKey with no hashing, cache or Convex call", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      cachedFetchJson.mockResolvedValue(VALID_RESULT); // would authenticate if reached
      await expect(validateUserApiKey(VALID_EMBED_KEY)).resolves.toBeNull();
      expect(cachedFetchJson).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  test("a wm_ key is rejected by validateEmbedKey with no hashing, cache or Convex call", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      cachedFetchJson.mockResolvedValue(VALID_RESULT);
      await expect(validateEmbedKey(VALID_USER_KEY)).resolves.toBeNull();
      expect(cachedFetchJson).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  test("the enterprise-shaped and session-token prefixes are rejected too", async () => {
    cachedFetchJson.mockResolvedValue(VALID_RESULT);
    for (const key of ["", "wms_session", "sk_live_abc", `wm_${"a".repeat(64)}`]) {
      await expect(validateEmbedKey(key)).resolves.toBeNull();
    }
    expect(cachedFetchJson).not.toHaveBeenCalled();
  });
});

describe("malformed embed keys are rejected without amplification", () => {
  const MALFORMED: Array<[string, string]> = [
    ["too short (wme_x)", "wme_x"],
    ["39 hex", `wme_${"a".repeat(39)}`],
    ["41 hex", `wme_${"a".repeat(41)}`],
    ["40 UPPERCASE hex", `wme_${"A1B2C3D4E5".repeat(4)}`],
    ["40 non-hex chars", `wme_${"z".repeat(40)}`],
    ["prefix only", "wme_"],
    ["trailing whitespace", `wme_${"a".repeat(40)} `],
    ["leading whitespace", ` wme_${"a".repeat(40)}`],
    ["embedded newline", `wme_${"a".repeat(40)}\n`],
  ];

  for (const [label, key] of MALFORMED) {
    test(`${label} → null AND no hashing, no cache, no Convex call`, async () => {
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        cachedFetchJson.mockResolvedValue(VALID_RESULT);
        await expect(validateEmbedKey(key)).resolves.toBeNull();
        expect(cachedFetchJson).not.toHaveBeenCalled();
        expect(digest).not.toHaveBeenCalled();
      } finally {
        digest.mockRestore();
      }
    });
  }
});

describe("non-conforming backend/cache payloads must not authenticate", () => {
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
      await expect(validateEmbedKey(VALID_EMBED_KEY)).resolves.toBeNull();
    });
  }

  test("the real Convex row shape (id, not keyId) still authenticates", async () => {
    const row = { id: "j97xyz", userId: "u1", name: "partner-site" };
    cachedFetchJson.mockResolvedValue(row);
    await expect(validateEmbedKey(VALID_EMBED_KEY)).resolves.toEqual(row);
  });
});

describe("transient failures stay retryable", () => {
  test("a fetcher error surfaces as EmbedKeyUnavailableError, not a 401-shaped null", async () => {
    cachedFetchJson.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(validateEmbedKey(VALID_EMBED_KEY)).rejects.toSatisfy(isEmbedKeyUnavailableError);
  });

  test("the message is namespaced to the embed surface", async () => {
    cachedFetchJson.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(validateEmbedKey(VALID_EMBED_KEY)).rejects.toThrow(
      /Convex embed key validation unavailable/,
    );
  });
});
