import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { modules, schema } from "./companyMonitoring.helpers";

const { dodoUpdate } = vi.hoisted(() => ({
  dodoUpdate: vi.fn<(id: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("dodopayments", () => ({
  DodoPayments: class { subscriptions = { update: dodoUpdate }; },
  NotFoundError: class extends Error {},
  APIConnectionTimeoutError: class extends Error {},
  APIConnectionError: class extends Error {},
}));

const fetchMock = vi.fn<typeof fetch>();
function hostnameOf(urlLike: string): string | null {
  try {
    return new URL(urlLike).hostname;
  } catch {
    return null;
  }
}
// CodeQL js/incomplete-url-substring-sanitization: match the URL host, not a
// substring, so an arbitrary host containing "api.clerk.com" cannot pass.
function isClerkApiUrl(urlLike: string): boolean {
  return hostnameOf(urlLike) === "api.clerk.com";
}
function isRedisPipelineUrl(urlLike: string): boolean {
  try {
    return new URL(urlLike).pathname === "/pipeline";
  } catch {
    return false;
  }
}
function success(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (String(init?.body).startsWith('["SCAN",')) return Promise.resolve(Response.json({ result: ["0", []] }));
  const url = String(input);
  if (isClerkApiUrl(url)) return Promise.resolve(new Response(null, { status: 204 }));
  return Promise.resolve(Response.json(isRedisPipelineUrl(url) ? [{ result: 1 }] : { result: null }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("DODO_API_KEY", "test-dodo");
  vi.stubEnv("CLERK_SECRET_KEY", "test-clerk");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-redis");
  dodoUpdate.mockReset().mockResolvedValue({ status: "cancelled" });
  fetchMock.mockReset().mockImplementation(success);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(subscriptionIds: string[] = []) {
  const t = convexTest(schema, modules);
  const deletionId = await t.run((ctx) => ctx.db.insert("accountDeletions", {
    userId: "user_retry", userIdHash: "hash", source: "self", status: "pending",
    step: "external", dodoSubscriptionIds: subscriptionIds, startedAt: Date.now(), updatedAt: Date.now(),
  }));
  return { t, deletionId, row: () => t.run((ctx) => ctx.db.get(deletionId)) };
}

async function pendingJobs(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((job) => job.state.kind === "pending"));
}

describe("external account deletion retry policy", () => {
  test.each(["DODO_API_KEY", "CLERK_SECRET_KEY", "UPSTASH_REDIS_REST_TOKEN"])(
    "missing %s fails without scheduling more work", async (key) => {
      vi.stubEnv(key, "");
      const { t, deletionId, row } = await setup(["sub_1"]);
      expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
        .toEqual({ status: "failed" });
      expect((await row())?.externalAttempts).toBe(1);
      expect((await row())?.status).toBe("failed");
      expect(await pendingJobs(t)).toHaveLength(0);
      const calls = fetchMock.mock.calls.length;
      await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId });
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    },
  );

  test.each([401, 403])("permanent Clerk HTTP %i fails without retries", async (status) => {
    fetchMock.mockImplementation((input, init) => isClerkApiUrl(String(input))
      ? Promise.resolve(new Response(null, { status })) : success(input, init));
    const { t, deletionId, row } = await setup();
    expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
      .toEqual({ status: "failed" });
    expect((await row())?.lastError).toContain(String(status));
    expect(await pendingJobs(t)).toHaveLength(0);
  });

  test("Dodo authentication failure still clears access caches and then stops", async () => {
    dodoUpdate.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    const { t, deletionId, row } = await setup(["sub_1"]);
    expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
      .toEqual({ status: "failed" });
    expect((await row())?.redisClearedAt).toBeDefined();
    expect(await pendingJobs(t)).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => isClerkApiUrl(String(input)))).toBe(false);
  });

  test("SDK connection failures retry and can recover", async () => {
    const { APIConnectionError } = await import("dodopayments");
    dodoUpdate.mockRejectedValueOnce(new APIConnectionError({ message: "Connection error" }))
      .mockResolvedValue({ status: "cancelled" });
    const { t, deletionId, row } = await setup(["sub_1"]);
    expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
      .toEqual({ status: "pending" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await row())?.status).toBe("complete");
    expect(dodoUpdate).toHaveBeenCalledTimes(2);
  });

  test("persistent transient failures back off and stop after five attempts", async () => {
    fetchMock.mockImplementation((input, init) => isClerkApiUrl(String(input))
      ? Promise.resolve(new Response(null, { status: 503 })) : success(input, init));
    const { t, deletionId, row } = await setup();
    const startedAt = Date.now();
    await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId });
    expect((await pendingJobs(t))[0]?.scheduledTime).toBe(startedAt + 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await t.finishInProgressScheduledFunctions();
    expect((await row())?.externalAttempts).toBe(2);
    expect((await pendingJobs(t))[0]?.scheduledTime).toBe(startedAt + 90_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await row())?.externalAttempts).toBe(5);
    expect((await row())?.status).toBe("failed");
    expect(await pendingJobs(t)).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([input]) => isClerkApiUrl(String(input)))).toHaveLength(5);
  });

  test("a transient Dodo failure resumes without cancelling completed subscriptions twice", async () => {
    dodoUpdate.mockResolvedValueOnce({ status: "cancelled" })
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValue({ status: "cancelled" });
    const { t, deletionId, row } = await setup(["sub_a", "sub_b"]);
    await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId });
    expect((await row())?.cancelledDodoSubscriptionIds).toEqual(["sub_a"]);
    expect((await row())?.redisClearedAt).toBeDefined();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await row())?.status).toBe("complete");
    expect(dodoUpdate.mock.calls.map(([id]) => id)).toEqual(["sub_a", "sub_b", "sub_b"]);
  });

  // The MCP negative-cache sentinels are SET commands inside the same
  // revocation pipeline as the DELs, so a per-command error on one of them —
  // Upstash answers HTTP 200 and reports the failure in the body — must still
  // block completion. Only the sentinel results are poisoned here; every other
  // command reports success, so this fails for the reason it claims to.
  test("an HTTP 200 error on the MCP sentinel write cannot complete deletion", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (!isRedisPipelineUrl(String(input))) return success(input);
      const commands = JSON.parse(String(init?.body ?? "[]")) as string[][];
      return Response.json(commands.map((command) => command[1]?.startsWith("pro-mcp-token-neg:")
        ? { error: "ERR denied" }
        : { result: 1 }));
    });
    const { t, deletionId, row } = await setup();
    await t.run((ctx) => ctx.db.patch(deletionId, { mcpTokenIds: ["token_1"] }));
    expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
      .toEqual({ status: "failed" });
    expect((await row())?.redisClearedAt).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => isClerkApiUrl(String(input)))).toBe(false);
    expect(await pendingJobs(t)).toHaveLength(0);
  });

  test("the revocation pipeline carries the MCP sentinels in one round trip", async () => {
    const { t, deletionId } = await setup();
    await t.run((ctx) => ctx.db.patch(deletionId, { mcpTokenIds: ["token_1", "token_2"] }));
    await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId });
    const pipelines = fetchMock.mock.calls
      .filter(([input]) => isRedisPipelineUrl(String(input)))
      .map(([, init]) => JSON.parse(String(init?.body ?? "[]")) as string[][]);
    // One pipeline for the whole revocation set, not one fetch per token.
    const withSets = pipelines.filter((commands) => commands.some((c) => c[0] === "SET" && c[1].startsWith("pro-mcp-token-neg:")));
    expect(withSets).toHaveLength(1);
    expect(withSets[0]?.filter((c) => c[0] === "SET").map((c) => c[1])).toEqual([
      "wm:notif:sent-erased:v1:user_retry",
      "pro-mcp-token-neg:token_1",
      "pro-mcp-token-neg:token_2",
    ]);
  });

  // The relay writes a recipient's alert history when its delivery pass ends,
  // which can be after this pipeline ran. That write is refused while the
  // marker exists (scripts/lib/sent-alert-history.cjs). The pipeline is not a
  // transaction, so the marker has to be set before the history is deleted: a
  // write landing between a DEL and a later SET would bring the history back.
  test("the alert-history deletion marker is set before the history is deleted", async () => {
    const { t, deletionId } = await setup();
    await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId });
    const commands = fetchMock.mock.calls
      .filter(([input]) => isRedisPipelineUrl(String(input)))
      .map(([, init]) => JSON.parse(String(init?.body ?? "[]")) as string[][])
      .find((pipeline) => pipeline.some((c) => c[1] === "wm:notif:sent:v1:user_retry")) ?? [];
    const marker = commands.findIndex((c) => c[1] === "wm:notif:sent-erased:v1:user_retry");
    const historyDelete = commands.findIndex((c) => c[0] === "DEL" && c[1] === "wm:notif:sent:v1:user_retry");
    expect(commands[marker]).toEqual([
      "SET", "wm:notif:sent-erased:v1:user_retry", "1", "EX", String(7 * 24 * 60 * 60),
    ]);
    expect(historyDelete).toBeGreaterThan(marker);
  });

  // Without the marker a late relay write recreates the deleted history, so a
  // marker that was not stored must not let the deletion finish.
  test("an HTTP 200 error on the alert-history marker write cannot complete deletion", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (!isRedisPipelineUrl(String(input))) return success(input);
      const commands = JSON.parse(String(init?.body ?? "[]")) as string[][];
      return Response.json(commands.map((command) => command[1]?.startsWith("wm:notif:sent-erased:v1:")
        ? { error: "ERR denied" }
        : { result: 1 }));
    });
    const { t, deletionId, row } = await setup();
    expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
      .toEqual({ status: "failed" });
    expect((await row())?.redisClearedAt).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => isClerkApiUrl(String(input)))).toBe(false);
  });

  test.each(["/get/", "/pipeline"])("Redis HTTP 200 error on %s cannot complete deletion", async (operation) => {
    fetchMock.mockImplementation((input, init) => String(input).includes(operation)
      ? Promise.resolve(Response.json(operation === "/pipeline" ? [{ error: "ERR denied" }] : { error: "ERR denied" }))
      : success(input, init));
    const { t, deletionId, row } = await setup();
    await t.run((ctx) => ctx.db.patch(deletionId, { mcpTokenIds: ["token_1"] }));
    expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
      .toEqual({ status: "failed" });
    expect((await row())?.redisClearedAt).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => isClerkApiUrl(String(input)))).toBe(false);
    expect(await pendingJobs(t)).toHaveLength(0);
  });
});
