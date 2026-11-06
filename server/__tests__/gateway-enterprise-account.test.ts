// @vitest-environment node

/**
 * Enterprise contract accounts (plan U3) — pooled REST metering.
 *
 * Members of a live contract draw on ONE daily pool keyed `acct:<id>` and one
 * per-minute burst. Past the contract allowance traffic is served and counted
 * as overage; at allowance × breakerMultiple it is rejected. Both limits are
 * enforced whatever `API_RATE_LIMIT_ENFORCE` says.
 *
 * The daily meter here is the REAL `reserveDailyMeter` running against an
 * in-memory Redis, so the pooled and per-member counters are asserted as
 * stored values. Only the Upstash-backed burst limiter is stubbed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// --- In-memory Redis behind runRedisPipeline --------------------------------
const store = new Map<string, number>();
let pipelineFails = false;
const runRedisPipeline = vi.fn(async (commands: Array<Array<string | number>>) => {
  if (pipelineFails) return [];
  return commands.map(([cmd, key, arg]) => {
    const k = String(key);
    const current = store.get(k) ?? 0;
    switch (String(cmd).toUpperCase()) {
      case "INCR": store.set(k, current + 1); return { result: current + 1 };
      case "INCRBY": store.set(k, current + Number(arg)); return { result: current + Number(arg) };
      case "DECR": store.set(k, current - 1); return { result: current - 1 };
      case "EXPIRE": return { result: 1 };
      default: return { result: null };
    }
  });
});
vi.mock("../_shared/redis", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/redis")>();
  return { ...actual, runRedisPipeline: (...a: Parameters<typeof runRedisPipeline>) => runRedisPipeline(...a) };
});

// --- Stub only the burst limiter; keep the real daily meter -----------------
const checkBurst = vi.fn();
vi.mock("../_shared/api-key-rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/api-key-rate-limit")>();
  return { ...actual, checkBurst: (...a: unknown[]) => checkBurst(...a) };
});

const checkRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkFailClosedScopedIpRateLimit: vi.fn().mockResolvedValue(null),
    checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
    hasEndpointRatePolicy: () => false,
  };
});

const reportHighUsageIfCrossed = vi.fn();
vi.mock("../_shared/high-usage-alarm", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/high-usage-alarm")>();
  return { ...actual, reportHighUsageIfCrossed: (...a: unknown[]) => reportHighUsageIfCrossed(...a) };
});

// --- Capture usage events ----------------------------------------------------
const events: Array<Record<string, unknown>> = [];
vi.mock("../_shared/usage", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/usage")>();
  return {
    ...actual,
    deliverUsageEvents: async (batch: Array<Record<string, unknown>>) => { events.push(...batch); },
  };
});

// --- Entitlements: two members of one account, plus a non-member ------------
const ACCOUNT = {
  id: "acct_hexion",
  dailyAllowance: 10_000,
  perMinuteBurst: 300,
  breakerMultiple: 5,
  monthlyInputTokens: 50_000_000,
  monthlyOutputTokens: 5_000_000,
};
function enterprise(account?: typeof ACCOUNT) {
  return {
    planKey: "enterprise",
    features: {
      tier: 3,
      apiAccess: true,
      apiRateLimit: 300,
      apiDailyAllowance: 10_000,
      maxDashboards: 100,
      prioritySupport: true,
      exportFormats: ["csv"],
      mcpAccess: true,
    },
    validUntil: Date.now() + 86_400_000,
    ...(account ? { account } : {}),
  };
}
const entitlements: Record<string, ReturnType<typeof enterprise>> = {
  user_alice: enterprise(ACCOUNT),
  user_bob: enterprise(ACCOUNT),
  user_solo: enterprise(),
};
vi.mock("../_shared/entitlement-check", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    getRequiredTier: () => null,
    checkEntitlement: vi.fn().mockResolvedValue(null),
    checkEntitlementDetailed: vi.fn().mockResolvedValue({ response: null, entitlements: null }),
    getEntitlements: vi.fn(async (userId: string) => entitlements[userId] ?? null),
  };
});

const KEY_OWNERS: Record<string, string> = {
  wm_key_alice: "user_alice",
  wm_key_bob: "user_bob",
  wm_key_solo: "user_solo",
};
vi.mock("../_shared/user-api-key", () => ({
  validateUserApiKeyPrincipal: vi.fn(async (key: string) => KEY_OWNERS[key]
    ? { userId: KEY_OWNERS[key], keyId: `k_${key}`, keyKind: "api", keyHash: "h".repeat(64), activeKeyRank: 0 }
    : null),
}));

import { createDomainGateway } from "../gateway";
import { apiKeyDailyKey, apiKeyMemberDailyKey } from "../_shared/api-key-rate-limit";

const POOL_KEY = apiKeyDailyKey("acct:acct_hexion");
const ALICE_KEY = apiKeyMemberDailyKey("acct:acct_hexion", "user_alice");
const BOB_KEY = apiKeyMemberDailyKey("acct:acct_hexion", "user_bob");

function makeGateway() {
  return createDomainGateway([
    {
      method: "GET",
      path: "/api/news/v1/list-feed-digest",
      handler: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
  ]);
}

function keyRequest(key: string) {
  return new Request("https://www.worldmonitor.app/api/news/v1/list-feed-digest", {
    method: "GET",
    headers: { "X-Api-Key": key },
  });
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
async function settle() {
  let prev = -1;
  while (pending.length !== prev) {
    prev = pending.length;
    await Promise.allSettled(pending.slice(0, prev));
  }
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  store.clear();
  pipelineFails = false;
  events.length = 0;
  pending.length = 0;
  runRedisPipeline.mockClear();
  checkBurst.mockReset().mockResolvedValue({ ok: true });
  checkRateLimit.mockClear().mockResolvedValue(null);
  reportHighUsageIfCrossed.mockClear();
  delete process.env.API_RATE_LIMIT_ENFORCE;
  process.env.USAGE_TELEMETRY = "1";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("enterprise contract account — pooled REST metering", () => {
  test("AE1: members share one pool; responses past the allowance carry the overage header; per-member split", async () => {
    // Seed the day so the boundary is crossed with real requests: Alice has
    // made 5,999 calls and Bob 4,000, so the pool stands at 9,999.
    store.set(POOL_KEY, 9_999);
    store.set(ALICE_KEY, 5_999);
    store.set(BOB_KEY, 4_000);
    const gateway = makeGateway();

    // Request 10,000 — the last one inside the allowance.
    const atAllowance = await gateway(keyRequest("wm_key_alice"), ctx);
    expect(atAllowance.status).toBe(200);
    expect(atAllowance.headers.get("X-WorldMonitor-Overage")).toBeNull();
    expect(atAllowance.headers.get("RateLimit-Limit")).toBe("10000");
    expect(atAllowance.headers.get("RateLimit-Remaining")).toBe("0");

    // Requests 10,001 … 11,000 — all served, all marked as overage.
    for (let i = 0; i < 1_000; i += 1) {
      const res = await gateway(keyRequest("wm_key_bob"), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-WorldMonitor-Overage")).toBe("true");
      expect(res.headers.get("RateLimit-Limit")).toBe("10000");
      expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    }

    expect(store.get(POOL_KEY)).toBe(11_000);
    expect(store.get(ALICE_KEY)).toBe(6_000);
    expect(store.get(BOB_KEY)).toBe(5_000);
    // Both members drew on the same burst bucket at the contract burst.
    expect(new Set(checkBurst.mock.calls.map((call) => JSON.stringify(call)))).toEqual(
      new Set([JSON.stringify([300, "acct:acct_hexion"])]),
    );
    // The account layer governs: no fallback limiter, no high-usage page.
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(reportHighUsageIfCrossed).not.toHaveBeenCalled();
  }, 60_000);

  test("usage events carry account_id and overage", async () => {
    store.set(POOL_KEY, 9_999);
    const gateway = makeGateway();
    await gateway(keyRequest("wm_key_alice"), ctx);
    await gateway(keyRequest("wm_key_bob"), ctx);
    await settle();
    const rows = events.filter((e) => e.event_type === "request");
    expect(rows.map((e) => [e.account_id, e.overage])).toEqual([
      ["acct_hexion", false],
      ["acct_hexion", true],
    ]);
  });

  test("a served request shows the contract allowance in rate-limit headers", async () => {
    const res = await makeGateway()(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBe("10000");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10000");
    expect(res.headers.get("RateLimit-Remaining")).toBe("9999");
    expect(res.headers.get("RateLimit-Policy")).toBe('"default";q=10000;w=86400');
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("X-WorldMonitor-Overage")).toBeNull();
  });

  test("AE2: at the safety limit the next request is rejected with the flag unset, and the count stays at the limit", async () => {
    store.set(POOL_KEY, 50_000);
    store.set(BOB_KEY, 20_000);
    const res = await makeGateway()(keyRequest("wm_key_bob"), ctx);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      limit_type: "daily",
      limit: 50_000,
      allowance: 10_000,
      plan: "enterprise",
    });
    expect(body.upgrade_url).toBeUndefined();
    expect(String(body.message)).toMatch(/daily safety limit/i);
    expect(res.headers.get("RateLimit-Limit")).toBe("10000");
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(store.get(POOL_KEY)).toBe(50_000);
    expect(store.get(BOB_KEY)).toBe(20_000);
  });

  test("the last request below the safety limit is still served as overage", async () => {
    store.set(POOL_KEY, 49_999);
    const res = await makeGateway()(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-WorldMonitor-Overage")).toBe("true");
    expect(store.get(POOL_KEY)).toBe(50_000);
  });

  test("burst over the contract rate → 429 per_minute with the flag unset", async () => {
    checkBurst.mockResolvedValue({ ok: false, limit: 300, reset: Date.now() + 30_000 });
    const res = await makeGateway()(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ limit_type: "per_minute", limit: 300 });
    expect(checkBurst).toHaveBeenCalledWith(300, "acct:acct_hexion");
    // Nothing was charged for a rejected burst.
    expect(store.get(POOL_KEY)).toBeUndefined();
  });

  test("Redis pipeline failure → served, unmetered, no 429 and no allowance headers", async () => {
    pipelineFails = true;
    const res = await makeGateway()(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-WorldMonitor-Overage")).toBeNull();
    await settle();
    const row = events.find((e) => e.event_type === "request");
    expect(row).toMatchObject({ account_id: "acct_hexion", overage: null });
  });

  test("burst limiter unavailable: the fallback limiter still applies, and its rejection releases the pooled and member counts", async () => {
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    store.set(POOL_KEY, 10_500);
    store.set(ALICE_KEY, 7);
    checkRateLimit.mockResolvedValue(new Response("fallback", { status: 429 }));
    const res = await makeGateway()(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-WorldMonitor-Overage")).toBeNull();
    expect(store.get(POOL_KEY)).toBe(10_500);
    expect(store.get(ALICE_KEY)).toBe(7);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.any(Object),
      { principalUserId: "user_alice", principalScope: "api_key" });
    await settle();
    expect(events.find((e) => e.event_type === "request")).toMatchObject({ account_id: "acct_hexion", overage: null });
  });

  test("a handler crash releases the pooled and member counts and is not overage", async () => {
    store.set(POOL_KEY, 10_500);
    store.set(ALICE_KEY, 7);
    const gateway = createDomainGateway([
      {
        method: "GET",
        path: "/api/news/v1/list-feed-digest",
        handler: async () => { throw new Error("handler exploded"); },
      },
    ]);
    const res = await gateway(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("X-WorldMonitor-Overage")).toBeNull();
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
    expect(store.get(POOL_KEY)).toBe(10_500);
    expect(store.get(ALICE_KEY)).toBe(7);
    await settle();
    expect(events.find((e) => e.event_type === "request")).toMatchObject({ account_id: "acct_hexion", overage: null });
  });

  test("a handler-returned 5xx is not billed: counts released, no overage", async () => {
    store.set(POOL_KEY, 10_500);
    store.set(ALICE_KEY, 7);
    const gateway = createDomainGateway([
      {
        method: "GET",
        path: "/api/news/v1/list-feed-digest",
        handler: async () => new Response(JSON.stringify({ error: "upstream" }), { status: 502 }),
      },
    ]);
    const res = await gateway(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(502);
    expect(res.headers.get("X-WorldMonitor-Overage")).toBeNull();
    expect(store.get(POOL_KEY)).toBe(10_500);
    expect(store.get(ALICE_KEY)).toBe(7);
    await settle();
    expect(events.find((e) => e.event_type === "request")).toMatchObject({ account_id: "acct_hexion", overage: null });
  });

  test("a 200 whose body stream fails to read rejects and is not billed", async () => {
    store.set(POOL_KEY, 10_500);
    store.set(ALICE_KEY, 7);
    const gateway = createDomainGateway([
      {
        method: "GET",
        path: "/api/news/v1/list-feed-digest",
        handler: async () => new Response(new ReadableStream({
          pull(controller) { controller.error(new Error("stream broke")); },
        }), { status: 200 }),
      },
    ]);
    await expect(gateway(keyRequest("wm_key_alice"), ctx)).rejects.toThrow("stream broke");
    expect(store.get(POOL_KEY)).toBe(10_500);
    expect(store.get(ALICE_KEY)).toBe(7);
  });

  test("a 4xx from the handler still counts (control)", async () => {
    store.set(POOL_KEY, 10_500);
    const gateway = createDomainGateway([
      {
        method: "GET",
        path: "/api/news/v1/list-feed-digest",
        handler: async () => new Response(JSON.stringify({ error: "bad input" }), { status: 400 }),
      },
    ]);
    const res = await gateway(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(400);
    expect(store.get(POOL_KEY)).toBe(10_501);
  });

  test("burst limiter unavailable and fallback admits: served as overage with allowance headers", async () => {
    checkBurst.mockResolvedValue({ ok: null, reason: "timeout" });
    store.set(POOL_KEY, 10_500);
    const res = await makeGateway()(keyRequest("wm_key_alice"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-WorldMonitor-Overage")).toBe("true");
    expect(store.get(POOL_KEY)).toBe(10_501);
  });

  test("non-member Enterprise user keeps per-user identity and shadow behaviour when the flag is unset", async () => {
    checkBurst.mockResolvedValue({ ok: false, limit: 300, reset: Date.now() + 30_000 });
    const res = await makeGateway()(keyRequest("wm_key_solo"), ctx);
    expect(res.status).toBe(200);
    expect(checkBurst).toHaveBeenCalledWith(300, "user_solo");
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
    // Shadow keeps the principal-scoped fallback active.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    await settle();
    expect(events.find((e) => e.event_type === "request")).toMatchObject({ account_id: null, overage: null });
  });

  test("non-member over its daily allowance is served in shadow and the per-user key is charged", async () => {
    store.set(apiKeyDailyKey("user_solo"), 10_000);
    const res = await makeGateway()(keyRequest("wm_key_solo"), ctx);
    expect(res.status).toBe(200);
    expect(store.get(apiKeyDailyKey("user_solo"))).toBe(10_001);
    expect(reportHighUsageIfCrossed).toHaveBeenCalledTimes(1);
  });
});
