// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  UserApiKeyUnavailableError,
  validateUserApiKey,
} from "../_shared/user-api-key";
import { __clearLocalUnavailableBackoffForTests } from "../_shared/redis";

const VALID_KEY = `wm_${"1234567890abcdef".repeat(2)}12345678`;
const VALID_RESULT = { id: "key_123", userId: "user_123", name: "prod" };

const ORIGINAL_ENV = {
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  CONVEX_SERVER_SHARED_SECRET: process.env.CONVEX_SERVER_SHARED_SECRET,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
};

function response(value: unknown, status = 200): Response {
  return new Response(value === undefined ? undefined : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installHttpHarness(convexResponses: Array<Response | Error>) {
  const redis = new Map<string, string>();
  let convexCalls = 0;

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://redis.test/get/")) {
      const key = decodeURIComponent(url.slice("https://redis.test/get/".length));
      return response({ result: redis.get(key) });
    }
    if (url === "https://redis.test/") {
      const command = JSON.parse(String(init?.body)) as [string, string, string];
      expect(command[0]).toBe("SET");
      redis.set(command[1], command[2]);
      return response({ result: "OK" });
    }
    if (url === "https://convex.test/api/internal-validate-api-key") {
      convexCalls += 1;
      const next = convexResponses.shift();
      if (!next) throw new Error("Unexpected Convex validation request");
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }));

  return {
    redis,
    convexCalls: () => convexCalls,
  };
}

beforeEach(() => {
  process.env.CONVEX_SITE_URL = "https://convex.test";
  process.env.CONVEX_SERVER_SHARED_SECRET = "test-shared-secret";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  __clearLocalUnavailableBackoffForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __clearLocalUnavailableBackoffForTests();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.sequential("validateUserApiKey negative caching", () => {
  test("throws unavailable on transient failure, then authenticates after backoff clear", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = installHttpHarness([
      response({ error: "temporary" }, 503),
      response(VALID_RESULT),
    ]);

    await expect(validateUserApiKey(VALID_KEY)).rejects.toBeInstanceOf(UserApiKeyUnavailableError);
    expect([...harness.redis.values()]).not.toContain(JSON.stringify("__WM_NEG__"));
    expect(warn.mock.calls.flat().join(" ")).toContain("validateUserApiKey unavailable");

    // Short isolate-local unavailable backoff suppresses Convex fan-out.
    await expect(validateUserApiKey(VALID_KEY)).rejects.toBeInstanceOf(UserApiKeyUnavailableError);
    expect(harness.convexCalls()).toBe(1);

    __clearLocalUnavailableBackoffForTests();
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(VALID_RESULT);
    expect(harness.convexCalls()).toBe(2);
  });

  test("throws unavailable on fetch rejection, then authenticates after backoff clear", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = installHttpHarness([
      new DOMException("The operation was aborted", "AbortError"),
      response(VALID_RESULT),
    ]);

    await expect(validateUserApiKey(VALID_KEY)).rejects.toBeInstanceOf(UserApiKeyUnavailableError);
    expect([...harness.redis.values()]).not.toContain(JSON.stringify("__WM_NEG__"));

    __clearLocalUnavailableBackoffForTests();
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(VALID_RESULT);
    expect(harness.convexCalls()).toBe(2);
  });

  test("negative-caches a definitive unknown key", async () => {
    const harness = installHttpHarness([response(null)]);

    await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
    expect([...harness.redis.values()]).toContain(JSON.stringify("__WM_NEG__"));

    await expect(validateUserApiKey(VALID_KEY)).resolves.toBeNull();
    expect(harness.convexCalls()).toBe(1);
  });

  test("does not cache a malformed Convex payload as an invalid key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = installHttpHarness([
      response({}),
      response(VALID_RESULT),
    ]);

    await expect(validateUserApiKey(VALID_KEY)).rejects.toBeInstanceOf(UserApiKeyUnavailableError);
    expect([...harness.redis.values()]).not.toContain(JSON.stringify("__WM_NEG__"));

    __clearLocalUnavailableBackoffForTests();
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(VALID_RESULT);
    expect(harness.convexCalls()).toBe(2);
  });

  test("throws unavailable on invalid JSON, then authenticates after backoff clear", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = installHttpHarness([
      new Response("{invalid-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      response(VALID_RESULT),
    ]);

    await expect(validateUserApiKey(VALID_KEY)).rejects.toBeInstanceOf(UserApiKeyUnavailableError);
    expect([...harness.redis.values()]).not.toContain(JSON.stringify("__WM_NEG__"));

    __clearLocalUnavailableBackoffForTests();
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(VALID_RESULT);
    expect(harness.convexCalls()).toBe(2);
  });

  test("throws unavailable on missing config, then authenticates once restored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = installHttpHarness([response(VALID_RESULT)]);
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;

    await expect(validateUserApiKey(VALID_KEY)).rejects.toBeInstanceOf(UserApiKeyUnavailableError);
    expect([...harness.redis.values()]).not.toContain(JSON.stringify("__WM_NEG__"));
    expect(harness.convexCalls()).toBe(0);

    process.env.CONVEX_SITE_URL = "https://convex.test";
    process.env.CONVEX_SERVER_SHARED_SECRET = "test-shared-secret";
    __clearLocalUnavailableBackoffForTests();
    await expect(validateUserApiKey(VALID_KEY)).resolves.toEqual(VALID_RESULT);
    expect(harness.convexCalls()).toBe(1);
  });
});
