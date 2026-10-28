import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  accountFor,
  company,
  grant,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  OWNER_A,
  schema,
  setStoredEntitlement,
} from "./companyMonitoring.helpers";

installCompanyMonitoringTestEnvironment();

describe("account-bound Company Monitoring API-key scopes", () => {
  test("issuing the first scoped key provisions the root, and an unscoped key does not", async () => {
    const t = convexTest(schema, modules);
    // Bare grant: the entitlement write no longer provisions anything (#6256).
    await grant(t, OWNER_A, "api_starter");
    expect(await accountFor(t, OWNER_A)).toBeNull();

    // An unscoped key must stay entirely off Company Monitoring.
    await t.withIdentity({ subject: OWNER_A, tokenIdentifier: `clerk|${OWNER_A}` }).mutation(
      api.apiKeys.createApiKey,
      { name: "generic", keyPrefix: "wm_ddddd", keyHash: "d".repeat(64) },
    );
    expect(await accountFor(t, OWNER_A)).toBeNull();

    // Requesting scopes is a first-use entry point: it provisions.
    const scoped = await t.withIdentity({ subject: OWNER_A, tokenIdentifier: `clerk|${OWNER_A}` })
      .mutation(api.apiKeys.createApiKey, {
        name: "company-monitoring",
        keyPrefix: "wm_eeeee",
        keyHash: "e".repeat(64),
        scopes: ["company_monitoring:read"],
      });

    const account = await accountFor(t, OWNER_A);
    expect(account).toMatchObject({ ownerUserId: OWNER_A, lifecycle: "entitled" });
    expect(scoped.companyMonitoringAccountId).toBe(account?.logicalAccountId);
  });

  test("scoped keys carry the exact active account binding and stale activation fails closed", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A, "api_starter");
    const account = await accountFor(t, OWNER_A);

    const key = await t.withIdentity({ subject: OWNER_A, tokenIdentifier: `clerk|${OWNER_A}` }).mutation(
      api.apiKeys.createApiKey,
      {
        name: "company-monitoring",
        keyPrefix: "wm_abcde",
        keyHash: "a".repeat(64),
        scopes: ["company_monitoring:read", "company_monitoring:write"],
      },
    );
    const valid = await t.query(internal.apiKeys.validateKeyByHash, { keyHash: "a".repeat(64) });
    expect(valid).toMatchObject({
      id: key.id,
      userId: OWNER_A,
      scopes: ["company_monitoring:read", "company_monitoring:write"],
      companyMonitoringAccountId: account?.logicalAccountId,
    });

    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((job) => job.name.includes("invalidateUserApiKeyCaches"))).toBe(true);
    await expect(
      t.query(internal.apiKeys.validateKeyByHash, { keyHash: "a".repeat(64) }),
    ).resolves.toBeNull();
  });

  test("cache invalidation no-ops without either Redis setting", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      t.action(internal.payments.cacheActions.invalidateUserApiKeyCaches, {
        keyHashes: ["f".repeat(64)],
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("URL-only cache invalidation rejects before fetch", async () => {
    const t = convexTest(schema, modules);
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      t.action(internal.payments.cacheActions.invalidateUserApiKeyCaches, {
        keyHashes: ["f".repeat(64)],
      }),
    ).rejects.toThrow(/must be configured together/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("token-only lifecycle invalidation is scheduled and fails before fetch", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const account = await accountFor(t, OWNER_A);
    await t.run(async (ctx) => {
      await ctx.db.insert("userApiKeys", {
        userId: OWNER_A,
        name: "token-only-cache-key",
        keyPrefix: "wm_fffff",
        keyHash: "f".repeat(64),
        scopes: ["company_monitoring:read"],
        companyMonitoringAccountId: account!.logicalAccountId,
        createdAt: NOW,
      });
    });
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    const fetchMock = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await setStoredEntitlement(t, OWNER_A, "free", NOW - 1);
    const pending = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(pending.some((job) =>
      job.name.includes("invalidateUserApiKeyCaches") && job.state.kind === "pending"
    )).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const completed = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(completed.some((job) =>
      job.name.includes("invalidateUserApiKeyCaches") && job.state.kind === "failed"
    )).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("invalidateUserApiKeyCaches"),
      expect.objectContaining({ message: expect.stringMatching(/must be configured together/) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("production warm-cache invalidation sends bare keys with the required User-Agent", async () => {
    const t = convexTest(schema, modules);
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    process.env.VERCEL_ENV = "production";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([{ result: 1 }, { result: "0" }]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.payments.cacheActions.invalidateUserApiKeyCaches, {
      keyHashes: ["c".repeat(64)],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://redis.example/pipeline");
    expect(JSON.parse(String(init.body))).toEqual([
      ["DEL", `user-api-key:${"c".repeat(64)}`],
      ["DEL", `bootstrap-user-api-key-invalid:${"c".repeat(64)}`],
    ]);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "User-Agent": "worldmonitor-server/1.0 (redis)",
    });
  });

  test("Convex invalidation ignores Vercel preview metadata and targets production bare keys", async () => {
    const t = convexTest(schema, modules);
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([{ result: 1 }, { result: 1 }]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.payments.cacheActions.invalidateUserApiKeyCaches, {
      keyHashes: ["d".repeat(64)],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual([
      ["DEL", `user-api-key:${"d".repeat(64)}`],
      ["DEL", `bootstrap-user-api-key-invalid:${"d".repeat(64)}`],
    ]);
  });

  test.each([
    ["per-command error", [{ result: 1 }, { error: "upstream rejected DEL" }]],
    ["malformed command result", [{ result: 1 }, "not-an-object"]],
    ["wrong result count", [{ result: 1 }]],
  ])("HTTP-200 %s fails closed", async (_caseName, pipelineResults) => {
    const t = convexTest(schema, modules);
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify(pipelineResults),
      { status: 200 },
    )));

    await expect(
      t.action(internal.payments.cacheActions.invalidateUserApiKeyCaches, {
        keyHashes: ["e".repeat(64)],
      }),
    ).rejects.toThrow(/user API key cache DEL/);
  });

  test("ownerless scoped credentials fail closed", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userApiKeys", {
        userId: OWNER_A,
        name: "malformed-ownerless-key",
        keyPrefix: "wm_bbbbb",
        keyHash: "b".repeat(64),
        scopes: ["company_monitoring:read"],
        createdAt: NOW,
      });
    });
    await expect(
      t.query(internal.apiKeys.validateKeyByHash, { keyHash: "b".repeat(64) }),
    ).resolves.toBeNull();
  });
});
