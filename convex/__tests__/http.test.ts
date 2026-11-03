import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import http from "../http";
import { ConvexError } from "convex/values";
import { PREFERENCE_VARIANTS } from "../../shared/cloud-preferences-contract";
import {
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_WINDOW_MS,
} from "../constants";

const modules = import.meta.glob("../**/*.ts");

test('notification relay hides unexpected exceptions and retains server diagnostics', async () => {
  vi.stubEnv('CONVEX_TENANT_RELAY_SECRET', 'synthetic-relay-secret');
  const error = new Error('database synthetic-private-detail');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const route = http.lookup('/relay/notification-channels', 'POST')![0];
    const response = await (route as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler({
      runQuery: async () => { throw error; },
    }, new Request('https://convex.test/relay/notification-channels', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-relay-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get', userId: 'synthetic-user' }),
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Operation failed' });
    expect(log).toHaveBeenCalledWith('[notification-channels] Operation failed', error);
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});

test.each([['EMAIL_OWNERSHIP_REQUIRED', 400], ['PRO_REQUIRED', 402]] as const)(
  'notification relay preserves %s', async (code, status) => {
    vi.stubEnv('CONVEX_TENANT_RELAY_SECRET', 'synthetic-relay-secret');
    try {
      const route = http.lookup('/relay/notification-channels', 'POST')![0];
      const response = await (route as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler({
        runQuery: async () => { throw new ConvexError({ code }); },
      }, new Request('https://convex.test/relay/notification-channels', {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic-relay-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', userId: 'synthetic-user' }),
      }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

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

describe("preference HTTP variant boundaries", () => {
  afterEach(() => vi.unstubAllEnvs());

  function relayPost(variant: string): RequestInit {
    vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", "prefs-test-delivery-secret");
    return {
      method: "POST",
      headers: { Authorization: "Bearer prefs-test-delivery-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER.subject, variant }),
    };
  }

  function preferencePost(variant: string): RequestInit {
    return { ...makePost(0), body: JSON.stringify({ variant, data: { theme: variant }, expectedSyncVersion: 0 }) };
  }

  test.each(["", "unknown", "FULL", " full", "__proto__", "x".repeat(1024)])(
    "returns 400 for unsupported variants at write and relay facades (%s)", async variant => {
      const t = convexTest(schema, modules);
      const write = await t.withIdentity(USER).fetch("/api/user-prefs", preferencePost(variant));
      expect(write.status).toBe(400);
      expect(await write.json()).toEqual({ error: "INVALID_VARIANT" });
      expect(write.headers.get("Access-Control-Allow-Origin")).toBe("https://worldmonitor.app");
      const read = await t.fetch("/relay/user-preferences", relayPost(variant));
      expect(read.status).toBe(400);
      expect(await read.json()).toEqual({ error: "INVALID_VARIANT" });
      expect(await t.run(ctx => ctx.db.query("userPreferences").collect())).toEqual([]);
      expect(await t.run(ctx => ctx.db.query("userPreferenceWriteRateLimits").collect())).toEqual([]);
    },
  );

  test("keeps authentication ahead of variant validation", async () => {
    const t = convexTest(schema, modules);
    const write = await t.fetch("/api/user-prefs", preferencePost("unknown"));
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual({ error: "UNAUTHENTICATED" });
    const read = await t.fetch("/relay/user-preferences", { ...relayPost("unknown"), headers: {} });
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  test("round-trips every supported variant through write and relay facades", async () => {
    const t = convexTest(schema, modules);
    for (const variant of PREFERENCE_VARIANTS) {
      const write = await t.withIdentity(USER).fetch("/api/user-prefs", preferencePost(variant));
      expect(write.status).toBe(200);
      expect(await write.json()).toEqual({ syncVersion: 1 });
      const read = await t.fetch("/relay/user-preferences", relayPost(variant));
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ theme: variant });
    }
    expect(await t.run(ctx => ctx.db.query("userPreferences").collect())).toHaveLength(6);
  });
});
