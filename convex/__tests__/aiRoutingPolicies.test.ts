import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { internalAiRoutingPolicyHttpHandler, relayAiRoutingPolicyHttpHandler } from "../http";

const modules = import.meta.glob("../**/*.ts");

const CONVEX_SECRET = "test-convex-secret-ai-routing-policy-91xQ";
const USER = "user_hexion_api";

describe("AI routing policies", () => {
  beforeEach(() => {
    // The mutations schedule an Upstash cache delete; without credentials it is a no-op.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("a user without a row is unrestricted", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: USER })).toBeNull();
  });

  test("set stores a deduplicated allowlist, replaces it on update, and clear removes it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: USER,
      allowedProviders: ["anthropic", "anthropic"],
      reason: "Enterprise API Agreement clause 6.1",
    });
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: USER }))
      .toEqual({ allowedProviders: ["anthropic"] });

    await t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: USER,
      allowedProviders: ["anthropic", "openrouter"],
      reason: "Amended order form",
    });
    const rows = await t.run((ctx) => ctx.db.query("aiRoutingPolicies").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allowedProviders).toEqual(["anthropic", "openrouter"]);

    const cleared = await t.mutation(internal.entitlements.clearAiRoutingPolicy, { userId: USER });
    expect(cleared.removed).toBe(1);
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: USER })).toBeNull();
    // Each write scheduled the edge cache delete; run them to completion.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((job) => job.name)).toEqual([
      "payments/cacheActions:deleteAiRoutingPolicyCache",
      "payments/cacheActions:deleteAiRoutingPolicyCache",
      "payments/cacheActions:deleteAiRoutingPolicyCache",
    ]);
    expect(scheduled.every((job) => job.state.kind === "success")).toBe(true);
  });

  test("set rejects unknown providers, an empty list, and a missing reason", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: USER, allowedProviders: ["anthropc"], reason: "typo",
    })).rejects.toThrow(/Unknown AI provider/);
    await expect(t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: USER, allowedProviders: [], reason: "empty",
    })).rejects.toThrow(/at least one provider/);
    await expect(t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: USER, allowedProviders: ["anthropic"], reason: " ",
    })).rejects.toThrow(/reason is required/);
    expect(await t.run((ctx) => ctx.db.query("aiRoutingPolicies").collect())).toHaveLength(0);
  });
});

describe("/api/internal-ai-routing-policy HTTP action", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", CONVEX_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function call(runQuery: ReturnType<typeof vi.fn>, headers: Record<string, string>, body: unknown) {
    return internalAiRoutingPolicyHttpHandler(
      { runQuery } as unknown as ActionCtx,
      new Request("https://example.convex.site/api/internal-ai-routing-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  test("rejects a missing or wrong shared secret without reading the policy", async () => {
    const runQuery = vi.fn();
    expect((await call(runQuery, {}, { userId: USER })).status).toBe(401);
    expect((await call(runQuery, { "x-convex-shared-secret": "wrong" }, { userId: USER })).status).toBe(401);
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("returns the stored policy, or null for an unrestricted user", async () => {
    const restricted = vi.fn().mockResolvedValue({ allowedProviders: ["anthropic"] });
    const res = await call(restricted, { "x-convex-shared-secret": CONVEX_SECRET }, { userId: USER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: { allowedProviders: ["anthropic"] } });

    const open = vi.fn().mockResolvedValue(null);
    const openRes = await call(open, { "x-convex-shared-secret": CONVEX_SECRET }, { userId: USER });
    expect(await openRes.json()).toEqual({ policy: null });
  });

  test("rejects a missing user id", async () => {
    const res = await call(vi.fn(), { "x-convex-shared-secret": CONVEX_SECRET }, {});
    expect(res.status).toBe(400);
  });
});

describe("/relay/ai-routing-policy HTTP action", () => {
  const DELIVERY = "delivery-secret-ai-routing-41aa";

  beforeEach(() => {
    vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", DELIVERY);
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "gateway-secret-ai-routing-77bb");
    vi.stubEnv("RELAY_SHARED_SECRET", "ingestion-secret-ai-routing-99cc");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function call(runQuery: ReturnType<typeof vi.fn>, bearer: string | null, body: unknown) {
    return relayAiRoutingPolicyHttpHandler(
      { runQuery } as unknown as ActionCtx,
      new Request("https://example.convex.site/relay/ai-routing-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }

  test("accepts only the delivery relay secret", async () => {
    const runQuery = vi.fn().mockResolvedValue({ allowedProviders: ["anthropic"] });
    for (const bearer of [null, "wrong", "gateway-secret-ai-routing-77bb", "ingestion-secret-ai-routing-99cc"]) {
      expect((await call(runQuery, bearer, { userId: USER })).status).toBe(401);
    }
    expect(runQuery).not.toHaveBeenCalled();
    const res = await call(runQuery, DELIVERY, { userId: USER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: { allowedProviders: ["anthropic"] } });
  });

  test("rejects a missing user id", async () => {
    expect((await call(vi.fn(), DELIVERY, {})).status).toBe(400);
  });
});
