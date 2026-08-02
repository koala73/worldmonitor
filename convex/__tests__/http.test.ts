import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import {
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_WINDOW_MS,
} from "../constants";

const modules = import.meta.glob("../**/*.ts");

const TEST_NOW = 1_700_000_000_000;
const TEST_WINDOW_START = Math.floor(TEST_NOW / USER_PREFS_WRITE_RATE_WINDOW_MS) * USER_PREFS_WRITE_RATE_WINDOW_MS;
const TEST_RESET = TEST_WINDOW_START + USER_PREFS_WRITE_RATE_WINDOW_MS;
const USER = {
  subject: "user-prefs-http-rate",
  tokenIdentifier: "clerk|user-prefs-http-rate",
};

function makePost(expectedSyncVersion: number): RequestInit {
  return {
    method: "POST",
    headers: {
      Origin: "https://worldmonitor.app",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      variant: "full",
      data: { theme: `theme-${expectedSyncVersion}` },
      expectedSyncVersion,
      schemaVersion: 1,
    }),
  };
}

function expectExposedRateLimitHeaders(headers: Headers) {
  const exposed = headers.get("Access-Control-Expose-Headers") ?? "";
  expect(exposed).toContain("Retry-After");
  expect(exposed).toContain("X-RateLimit-Limit");
  expect(exposed).toContain("X-RateLimit-Remaining");
  expect(exposed).toContain("X-RateLimit-Reset");
}

describe("/api/user-prefs Convex HTTP action", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("preflight exposes retry and rate-limit headers", async () => {
    const t = convexTest(schema, modules);

    const res = await t.fetch("/api/user-prefs", {
      method: "OPTIONS",
      headers: { Origin: "https://worldmonitor.app" },
    });

    expect(res.status).toBe(204);
    expectExposedRateLimitHeaders(res.headers);
  });

  test.each([null, [], "not-an-object", 42, true])(
    "rejects non-object JSON body (%j) with 400 INVALID_JSON",
    async (payload) => {
      const t = convexTest(schema, modules);
      const res = await t.withIdentity(USER).fetch("/api/user-prefs", {
        method: "POST",
        headers: {
          Origin: "https://worldmonitor.app",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "INVALID_JSON" });
    },
  );

  test("maps mutation RATE_LIMITED errors to 429 with retry guidance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = convexTest(schema, modules);
    const authed = t.withIdentity(USER);

    for (let i = 0; i < USER_PREFS_WRITE_RATE_LIMIT; i++) {
      const res = await authed.fetch("/api/user-prefs", makePost(i));
      expect(res.status).toBe(200);
    }

    const res = await authed.fetch(
      "/api/user-prefs",
      makePost(USER_PREFS_WRITE_RATE_LIMIT),
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "RATE_LIMITED" });
    expect(res.headers.get("Retry-After")).toBe(String(Math.ceil((TEST_RESET - TEST_NOW) / 1000)));
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(USER_PREFS_WRITE_RATE_LIMIT));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(String(TEST_RESET));
    expectExposedRateLimitHeaders(res.headers);
  });
});
