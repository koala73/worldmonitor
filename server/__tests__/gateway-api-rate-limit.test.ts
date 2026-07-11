// @vitest-environment node

/**
 * U4 (#3199) — gateway wiring for the per-account API rate-limit layer.
 *
 * The per-account burst/meter math is unit-tested in
 * tests/api-key-rate-limit.test.mts; here we STUB that module (per the plan)
 * and assert only the GATEWAY wiring at server/gateway.ts:1034 — the parts the
 * reviewers flagged as defect-prone:
 *   - eligibility via isUserApiKey (user keys carry NO keyCheck.kind)
 *   - the per-IP bypass is ENFORCE-only (shadow keeps per-IP active)
 *   - ordering + 429 shape
 *   - downgraded / ineligible keys fall through to per-IP
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// --- Stub the per-account module: control the burst/meter decisions ---------
const checkBurst = vi.fn();
const reserveDailyMeter = vi.fn();
vi.mock("../_shared/api-key-rate-limit", () => ({
  checkBurst: (...a: unknown[]) => checkBurst(...a),
  reserveDailyMeter: (...a: unknown[]) => reserveDailyMeter(...a),
  rateLimitHeaders: () => ({ "X-RateLimit-Limit": "60", "Retry-After": "30" }),
  ENTERPRISE_API_RATE_LIMIT: 1000,
  CEILING_MULTIPLIER: 10,
}));

// --- Stub the per-IP layer: spy whether checkRateLimit runs ------------------
const checkRateLimit = vi.fn().mockResolvedValue(null);
vi.mock("../_shared/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
    hasEndpointRatePolicy: () => false,
  };
});

// --- Stub entitlement resolution: a Starter user, non-tier-gated route -------
const STARTER = {
  planKey: "api_starter",
  features: {
    tier: 2,
    apiAccess: true,
    apiRateLimit: 60,
    apiDailyAllowance: 1000,
    maxDashboards: 25,
    prioritySupport: false,
    exportFormats: ["csv"],
    mcpAccess: true,
  },
  validUntil: Date.now() + 86_400_000,
};
let entitlement: typeof STARTER | { planKey: string; features: Record<string, unknown>; validUntil: number } | null = STARTER;
vi.mock("../_shared/entitlement-check", () => ({
  getRequiredTier: () => null, // not tier-gated
  checkEntitlement: vi.fn().mockResolvedValue(null), // passes
  checkEntitlementDetailed: vi.fn().mockResolvedValue({ response: null, entitlements: null }), // passes
  getEntitlements: vi.fn(async () => entitlement),
}));

// --- Stub user-key validation: a valid wm_ key resolves to a userId ----------
vi.mock("../_shared/user-api-key", () => ({
  validateUserApiKey: vi.fn(async () => ({ userId: "acct_starter", keyId: "k1", name: "t" })),
}));

import { createDomainGateway } from "../gateway";

function makeGateway() {
  return createDomainGateway([
    {
      method: "GET",
      path: "/api/news/v1/list-feed-digest",
      handler: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  ]);
}

function userKeyRequest() {
  return new Request("https://www.worldmonitor.app/api/news/v1/list-feed-digest", {
    method: "GET",
    headers: { "X-Api-Key": "wm_test_starter_key" },
  });
}

const ctx = { waitUntil: () => {} };
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  entitlement = STARTER;
  checkBurst.mockReset().mockResolvedValue({ ok: true });
  reserveDailyMeter.mockReset().mockResolvedValue({
    count: 1,
    overCeiling: false,
    metered: true,
    retryAfterSec: 100,
    rollback: async () => {},
  });
  checkRateLimit.mockClear().mockResolvedValue(null);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("#3199 U4 — gateway per-account rate-limit wiring", () => {
  test("eligible Starter wm_ key engages the per-account layer (isUserApiKey discriminator)", async () => {
    const res = await makeGateway()(userKeyRequest(), ctx);
    expect(res.status).toBe(200);
    // The block ran the burst check for the user key — proves eligibility keys
    // on isUserApiKey, not keyCheck.kind (which is undefined for wm_ keys).
    expect(checkBurst).toHaveBeenCalledWith(60, "acct_starter");
  });

  test("ENFORCE + burst trip → 429 and per-IP checkRateLimit is BYPASSED", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    checkBurst.mockResolvedValue({ ok: false, limit: 60, reset: Date.now() + 30_000 });

    const res = await makeGateway()(userKeyRequest(), ctx);
    expect(res.status).toBe(429);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("SHADOW + burst trip → served (200) and per-IP checkRateLimit STILL runs", async () => {
    delete process.env.API_RATE_LIMIT_ENFORCE; // shadow (default)
    checkBurst.mockResolvedValue({ ok: false, limit: 60, reset: Date.now() + 30_000 });

    const res = await makeGateway()(userKeyRequest(), ctx);
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledTimes(1); // protection retained in shadow
  });

  test("ENFORCE + over-ceiling → 429, meter rolled back, per-IP bypassed", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    const rollback = vi.fn(async () => {});
    reserveDailyMeter.mockResolvedValue({
      count: 10_001,
      overCeiling: true,
      metered: true,
      retryAfterSec: 100,
      rollback,
    });

    const res = await makeGateway()(userKeyRequest(), ctx);
    expect(res.status).toBe(429);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("ENFORCE + within limits → served, per-IP bypassed", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    const res = await makeGateway()(userKeyRequest(), ctx);
    expect(res.status).toBe(200);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test("downgraded entitlement (apiAccess:false) → 403 (#4611), rejected before the rate-limit block", async () => {
    process.env.API_RATE_LIMIT_ENFORCE = "true";
    entitlement = { planKey: "pro", features: { tier: 1, apiAccess: false, apiRateLimit: 0 }, validUntil: Date.now() + 86_400_000 };

    const res = await makeGateway()(userKeyRequest(), ctx);
    // #4611: a wm_ key whose owner lost apiAccess is rejected outright, not
    // silently downgraded to the per-IP path. The apiAccess gate runs BEFORE
    // the #3199 per-account rate-limit block, so neither limiter is consulted.
    expect(res.status).toBe(403);
    expect(checkBurst).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
