import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  FEEDBACK_REPORTER_HOURLY_CAP,
  FEEDBACK_RETRY_WINDOW_MS,
  FEEDBACK_SECURITY_EMAILS_PER_DAY,
  securityEmailCounterName,
} from "../agentFeedback";

const modules = import.meta.glob("../**/*.ts");
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const SECRET = "synthetic-feedback-secret";

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
let seq = 0;
const uniqueHex = () => (++seq).toString(16).padStart(64, "0");

function report(overrides: Record<string, unknown> = {}) {
  return {
    kind: "bug" as const,
    surfaceType: "mcp_tool" as const,
    surfaceName: "get_market_data",
    summary: "Quotes are empty for AAPL",
    redacted: false,
    fingerprint: hex("a"),
    retryKey: uniqueHex(),
    reporterKey: `ip:${hex("b")}`,
    authKind: "anonymous" as const,
    ipHash: hex("b"),
    uaHash: hex("c"),
    ...overrides,
  };
}

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("agentFeedback").collect());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("submit", () => {
  test("inserts a received row and returns its id", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.agentFeedback.submit, report());
    expect(result).toMatchObject({ status: "received", retried: false });
    const [row] = await rows(t);
    expect(row._id).toBe(result.reportId);
    expect(row).toMatchObject({ status: "received", receivedAt: NOW, summary: "Quotes are empty for AAPL" });
    expect(row.notifyScheduledAt).toBeUndefined();
  });

  test("every report with the same fingerprint gets its own row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agentFeedback.submit, report({ requestId: "iad1::one" }));
    await t.mutation(internal.agentFeedback.submit, report({ requestId: "iad1::two" }));
    const stored = await rows(t);
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.requestId).sort()).toEqual(["iad1::one", "iad1::two"]);
  });

  test("a retry inside the window returns the first row without inserting", async () => {
    const t = convexTest(schema, modules);
    const retryKey = uniqueHex();
    const first = await t.mutation(internal.agentFeedback.submit, report({ retryKey }));
    vi.setSystemTime(NOW + FEEDBACK_RETRY_WINDOW_MS - 1);
    const second = await t.mutation(internal.agentFeedback.submit, report({ retryKey }));
    expect(second).toEqual({ reportId: first.reportId, status: "received", retried: true });
    expect(await rows(t)).toHaveLength(1);
    expect(await t.query(internal.agentFeedback.findRetry, { retryKey })).toEqual({
      reportId: first.reportId,
      status: "received",
    });
  });

  test("the same retry key outside the window inserts a new row", async () => {
    const t = convexTest(schema, modules);
    const retryKey = uniqueHex();
    await t.mutation(internal.agentFeedback.submit, report({ retryKey }));
    vi.setSystemTime(NOW + FEEDBACK_RETRY_WINDOW_MS + 1);
    expect(await t.query(internal.agentFeedback.findRetry, { retryKey })).toBeNull();
    const second = await t.mutation(internal.agentFeedback.submit, report({ retryKey }));
    expect(second.retried).toBe(false);
    expect(await rows(t)).toHaveLength(2);
  });

  test("clips text in code points as a second line", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agentFeedback.submit, report({
      summary: "界".repeat(400),
      expected: "  " + "x".repeat(2500) + "  ",
      actual: "   ",
      clientName: "c".repeat(200),
    }));
    const [row] = await rows(t);
    expect(Array.from(row.summary!)).toHaveLength(300);
    expect(row.expected).toHaveLength(2000);
    expect(row.actual).toBeUndefined();
    expect(row.clientName).toHaveLength(80);
  });

  test.each([
    ["fingerprint", { fingerprint: "not-a-hash" }],
    ["retryKey", { retryKey: "ABC" }],
    ["reporterKey", { reporterKey: "ip:raw-address" }],
    ["requestId", { requestId: "bad id with spaces" }],
    ["summary", { summary: "   " }],
    ["principalId", { authKind: "keyed", reporterKey: "principal:user_1" }],
    ["principalId", { principalId: "user_1" }],
    ["reporterKey", { reporterKey: `ip:${hex("d")}` }],
    ["reporterKey", { authKind: "keyed", principalId: "user_1", reporterKey: "principal:user_2", ipHash: undefined }],
  ])("rejects an invalid %s without storing", async (field, overrides) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.agentFeedback.submit, report(overrides))).rejects.toThrow(field);
    expect(await rows(t)).toHaveLength(0);
  });

  test.each(["pending", "complete", "failed"] as const)(
    "a keyed report for an account with a %s deletion is refused and stores nothing",
    async (status) => {
      const t = convexTest(schema, modules);
      await t.run((ctx) => ctx.db.insert("accountDeletions", {
        userId: "user_gone", userIdHash: "a".repeat(64), source: "self", status,
        step: "complete", dodoSubscriptionIds: [], startedAt: 1, updatedAt: 1,
      }));
      await expect(t.mutation(internal.agentFeedback.submit, report({
        authKind: "keyed", principalId: "user_gone", reporterKey: "principal:user_gone", ipHash: undefined,
      }))).rejects.toThrow("ACCOUNT_DELETION_IN_PROGRESS");
      expect(await rows(t)).toHaveLength(0);
      // Anonymous reports carry no account and are unaffected.
      await t.mutation(internal.agentFeedback.submit, report());
      expect(await rows(t)).toHaveLength(1);
    },
  );

  test("caps a single reporter per hour behind the edge limiter", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < FEEDBACK_REPORTER_HOURLY_CAP; i++) {
      await t.mutation(internal.agentFeedback.submit, report());
    }
    await expect(t.mutation(internal.agentFeedback.submit, report())).rejects.toThrow("rate_limited");
    // Another reporter is unaffected.
    await t.mutation(internal.agentFeedback.submit, report({ reporterKey: `ip:${hex("d")}`, ipHash: hex("d") }));
    expect(await rows(t)).toHaveLength(FEEDBACK_REPORTER_HOURLY_CAP + 1);
  });
});

describe("security reports", () => {
  const security = (overrides: Record<string, unknown> = {}) => {
    const ipHash = (overrides.ipHash as string | undefined) ?? uniqueHex();
    return report({ kind: "security", ipHash, reporterKey: `ip:${ipHash}`, ...overrides });
  };

  test("go straight to private and take one email slot", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.agentFeedback.submit, security());
    expect(result.status).toBe("private");
    const [row] = await rows(t);
    expect(row.notifyScheduledAt).toBe(NOW);
    const counter = await t.run((ctx) => ctx.db.query("counters").collect());
    expect(counter).toEqual([expect.objectContaining({ name: securityEmailCounterName(NOW), value: 1 })]);
  });

  test("a retried security report does not take a second slot", async () => {
    const t = convexTest(schema, modules);
    const retryKey = uniqueHex();
    const ipHash = uniqueHex();
    await t.mutation(internal.agentFeedback.submit, security({ retryKey, ipHash }));
    await t.mutation(internal.agentFeedback.submit, security({ retryKey, ipHash }));
    const counter = await t.run((ctx) => ctx.db.query("counters").first());
    expect(counter?.value).toBe(1);
  });

  test("past the daily cap the row is stored without scheduling a send", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < FEEDBACK_SECURITY_EMAILS_PER_DAY + 2; i++) {
      await t.mutation(internal.agentFeedback.submit, security());
    }
    const stored = await rows(t);
    expect(stored).toHaveLength(FEEDBACK_SECURITY_EMAILS_PER_DAY + 2);
    expect(stored.filter((r) => r.notifyScheduledAt !== undefined)).toHaveLength(FEEDBACK_SECURITY_EMAILS_PER_DAY);
    // The counter resets on the next UTC day.
    vi.setSystemTime(NOW + DAY);
    await t.mutation(internal.agentFeedback.submit, security());
    expect((await rows(t)).filter((r) => r.notifyScheduledAt === NOW + DAY)).toHaveLength(1);
  });

  test("the notice is sent once and carries no report text", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-resend");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.resend.com/emails");
      bodies.push(String(init.body));
      return Response.json({ id: "synthetic-email" });
    }));
    const t = convexTest(schema, modules);
    const { reportId } = await t.mutation(internal.agentFeedback.submit, security({
      summary: "SECRET-SUMMARY-TEXT",
      surfaceName: "SURFACE-LABEL",
      expected: "SECRET-EXPECTED",
    }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(reportId);
    for (const text of ["SECRET-SUMMARY-TEXT", "SURFACE-LABEL", "SECRET-EXPECTED"]) {
      expect(bodies[0]).not.toContain(text);
    }
    const [row] = await rows(t);
    expect(row.notifiedAt).toBe(NOW);

    // A second run of the action for the same row sends nothing.
    await t.action(internal.agentFeedback.notifySecurityReport, { reportId });
    expect(bodies).toHaveLength(1);
  });

  test("a failed send leaves notifiedAt unset for the digest", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-resend");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const t = convexTest(schema, modules);
    const { reportId } = await t.mutation(internal.agentFeedback.submit, security());
    await expect(t.action(internal.agentFeedback.notifySecurityReport, { reportId })).rejects.toThrow("Resend failed");
    const [row] = await rows(t);
    expect(row.notifiedAt).toBeUndefined();
  });

  test("the digest announces held-back and stale-scheduled rows, then marks them", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-resend");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ id: "synthetic-email" });
    }));
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const base = { ...security(), status: "private" as const, updatedAt: NOW, summary: "DIGEST-SECRET" };
      const heldBack = await ctx.db.insert("agentFeedback", { ...base, receivedAt: NOW - 1000 });
      const staleScheduled = await ctx.db.insert("agentFeedback", {
        ...base, receivedAt: NOW - 3 * 60 * 60 * 1000, notifyScheduledAt: NOW - 3 * 60 * 60 * 1000,
      });
      const inFlight = await ctx.db.insert("agentFeedback", { ...base, receivedAt: NOW - 1000, notifyScheduledAt: NOW - 1000 });
      const announced = await ctx.db.insert("agentFeedback", { ...base, receivedAt: NOW - 1000, notifiedAt: NOW - 500 });
      const closed = await ctx.db.insert("agentFeedback", { ...base, status: "closed", receivedAt: NOW - 1000 });
      const bug = await ctx.db.insert("agentFeedback", { ...base, kind: "bug", status: "received", receivedAt: NOW - 1000 });
      return { heldBack, staleScheduled, inFlight, announced, bug, closed };
    });

    expect(await t.action(internal.agentFeedback.sendSecurityDigest, {})).toEqual({ listed: 2 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(ids.heldBack);
    expect(bodies[0]).toContain(ids.staleScheduled);
    expect(bodies[0]).not.toContain(ids.inFlight);
    expect(bodies[0]).not.toContain(ids.bug);
    expect(bodies[0]).not.toContain(ids.closed);
    expect(bodies[0]).not.toContain("DIGEST-SECRET");

    // Marked rows are not listed again, and an empty digest sends nothing.
    expect(await t.action(internal.agentFeedback.sendSecurityDigest, {})).toEqual({ listed: 0 });
    expect(bodies).toHaveLength(1);
  });

  test("ineligible rows ahead in the index never hide an eligible one", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-resend");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ id: "synthetic-email" });
    }));
    const t = convexTest(schema, modules);
    const late = await t.run(async (ctx) => {
      const base = { ...security(), status: "private" as const, updatedAt: NOW };
      // 450 older rows that are not eligible: closed before closing stamped
      // notifiedAt, or still inside the grace window.
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert("agentFeedback", { ...base, status: "closed", receivedAt: NOW - 5 * DAY + i });
      }
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("agentFeedback", { ...base, receivedAt: NOW - 4 * DAY + i, notifyScheduledAt: NOW - 1000 });
      }
      return ctx.db.insert("agentFeedback", { ...base, receivedAt: NOW - 1000 });
    });
    expect(await t.action(internal.agentFeedback.sendSecurityDigest, {})).toEqual({ listed: 1 });
    expect(bodies[0]).toContain(late);
  });

  test("closing a private row takes it out of the digest index", async () => {
    const t = convexTest(schema, modules);
    const { reportId } = await t.mutation(internal.agentFeedback.submit, security());
    await t.mutation(internal.agentFeedback.transition, { reportId, to: "closed" });
    const [row] = await rows(t);
    expect(row.notifiedAt).toBe(NOW);
    expect(await t.action(internal.agentFeedback.sendSecurityDigest, { now: NOW + DAY })).toEqual({ listed: 0 });
  });
});

describe("transition", () => {
  test("filed drops text and keeps the issue number", async () => {
    const t = convexTest(schema, modules);
    const { reportId } = await t.mutation(internal.agentFeedback.submit, report({
      expected: "e", actual: "a", clientName: "n", requestId: "iad1::abc",
    }));
    await t.mutation(internal.agentFeedback.transition, { reportId, to: "triaged" });
    await t.mutation(internal.agentFeedback.transition, { reportId, to: "filed", issueNumber: 9999 });
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "filed", issueNumber: 9999, surfaceName: "get_market_data", fingerprint: hex("a") });
    // Decision 10: text and every reporter identifier go; keys are tombstoned.
    for (const field of ["summary", "expected", "actual", "clientName", "requestId", "principalId", "ipHash", "uaHash"] as const) {
      expect(row[field]).toBeUndefined();
    }
    expect(row.reporterKey).toBe("filed");
    expect(row.retryKey).toBe("filed");
  });

  test("a filed keyed row drops principalId (Decision 10)", async () => {
    const t = convexTest(schema, modules);
    const { reportId } = await t.mutation(internal.agentFeedback.submit, report({
      authKind: "keyed", principalId: "user_1", reporterKey: "principal:user_1", ipHash: undefined,
    }));
    await t.mutation(internal.agentFeedback.transition, { reportId, to: "filed", issueNumber: 1 });
    const [row] = await rows(t);
    expect(row.principalId).toBeUndefined();
    expect(row).toMatchObject({ status: "filed", issueNumber: 1, authKind: "keyed" });
  });

  test("security rows can only be closed", async () => {
    const t = convexTest(schema, modules);
    const { reportId } = await t.mutation(internal.agentFeedback.submit, report({ kind: "security" }));
    for (const to of ["filed", "triaged", "dismissed", "duplicate"] as const) {
      await expect(t.mutation(internal.agentFeedback.transition, { reportId, to, issueNumber: 1 })).rejects.toThrow("INVALID_TRANSITION");
    }
    await t.mutation(internal.agentFeedback.transition, { reportId, to: "closed" });
    expect((await rows(t))[0].status).toBe("closed");
  });

  test("duplicate needs an existing other row, filed needs an issue number", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(internal.agentFeedback.submit, report());
    const b = await t.mutation(internal.agentFeedback.submit, report());
    await expect(t.mutation(internal.agentFeedback.transition, { reportId: a.reportId, to: "duplicate", duplicateOf: a.reportId })).rejects.toThrow("duplicateOf");
    await expect(t.mutation(internal.agentFeedback.transition, { reportId: a.reportId, to: "filed" })).rejects.toThrow("issueNumber");
    await t.mutation(internal.agentFeedback.transition, { reportId: a.reportId, to: "duplicate", duplicateOf: b.reportId });
    await expect(t.mutation(internal.agentFeedback.transition, { reportId: a.reportId, to: "dismissed" })).rejects.toThrow("INVALID_TRANSITION");
  });
});

describe("prune", () => {
  test("deletes each status past its own bound, counted from receivedAt", async () => {
    const t = convexTest(schema, modules);
    const ages: Array<[string, number, boolean]> = [
      ["received", 31, true], ["received", 29, false],
      ["triaged", 31, true], ["dismissed", 31, true], ["duplicate", 31, true],
      ["filed", 364, false], ["filed", 366, true],
      ["private", 179, false], ["private", 181, true], ["closed", 181, true],
    ];
    await t.run(async (ctx) => {
      for (const [status, days] of ages) {
        // A recent updatedAt must not extend retention.
        await ctx.db.insert("agentFeedback", {
          ...report(), status: status as "received", receivedAt: NOW - days * DAY, updatedAt: NOW,
        });
      }
    });
    const result = await t.mutation(internal.agentFeedback.prune, {});
    expect(result).toEqual({ deleted: ages.filter(([, , gone]) => gone).length, rescheduled: false });
    const left = (await rows(t)).map((r) => `${r.status}:${Math.round((NOW - r.receivedAt) / DAY)}`).sort();
    expect(left).toEqual(["filed:364", "private:179", "received:29"]);
  });

  test("removes email counters older than two days and keeps recent ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const days of [0, 1, 3, 40]) {
        await ctx.db.insert("counters", { name: securityEmailCounterName(NOW - days * DAY), value: 1 });
      }
      await ctx.db.insert("counters", { name: "unrelated", value: 7 });
    });
    await t.mutation(internal.agentFeedback.prune, {});
    const names = (await t.run((ctx) => ctx.db.query("counters").collect())).map((c) => c.name).sort();
    expect(names).toEqual([securityEmailCounterName(NOW - DAY), securityEmailCounterName(NOW), "unrelated"].sort());
  });

  test("a non-positive limit cannot loop", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentFeedback", { ...report(), status: "received", receivedAt: NOW - 40 * DAY, updatedAt: NOW });
    });
    expect(await t.mutation(internal.agentFeedback.prune, { limit: 0 })).toEqual({ deleted: 1, rescheduled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rows(t)).toHaveLength(0);
  });

  test("self-drains when a batch is full", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("agentFeedback", { ...report(), status: "received", receivedAt: NOW - 40 * DAY, updatedAt: NOW });
      }
    });
    expect(await t.mutation(internal.agentFeedback.prune, { limit: 2 })).toEqual({ deleted: 2, rescheduled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rows(t)).toHaveLength(0);
  });
});

describe("HTTP routes", () => {
  const post = (path: string, body: unknown, secret?: string) => ({
    method: "POST",
    headers: secret ? { "x-convex-shared-secret": secret } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  test.each([undefined, "wrong"])("submit rejects secret %s before writing", async (secret) => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
    const t = convexTest(schema, modules);
    expect((await t.fetch("/api/internal-submit-feedback", post("/", report(), secret))).status).toBe(401);
    expect((await t.fetch("/api/internal-find-feedback-retry", post("/", { retryKey: hex("a") }, secret))).status).toBe(401);
    expect(await rows(t)).toHaveLength(0);
  });

  test("fails closed when the server secret is unset", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "");
    const t = convexTest(schema, modules);
    expect((await t.fetch("/api/internal-submit-feedback", post("/", report(), ""))).status).toBe(401);
  });

  test("writes through the mutation and absorbs a retry", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
    const t = convexTest(schema, modules);
    const body = report();
    const first = await t.fetch("/api/internal-submit-feedback", post("/", body, SECRET));
    expect(first.status).toBe(200);
    const created = await first.json();
    expect(created).toMatchObject({ status: "received", retried: false });

    const lookup = await t.fetch("/api/internal-find-feedback-retry", post("/", { retryKey: body.retryKey }, SECRET));
    expect(await lookup.json()).toEqual({ found: { reportId: created.reportId, status: "received" } });

    const again = await t.fetch("/api/internal-submit-feedback", post("/", body, SECRET));
    expect(await again.json()).toEqual({ ...created, retried: true });
    expect(await rows(t)).toHaveLength(1);
  });

  test.each([
    "null", "[]", "{",
    JSON.stringify({ ...report(), kind: "praise" }),
    JSON.stringify({ ...report(), redacted: "no" }),
    JSON.stringify({ ...report(), summary: 1 }),
  ])("rejects malformed body %s", async (body) => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
    const t = convexTest(schema, modules);
    const response = await t.fetch("/api/internal-submit-feedback", post("/", body, SECRET));
    expect(response.status).toBe(400);
    expect(await rows(t)).toHaveLength(0);
  });

  test("a mutation validation error names the field, never the value", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
    const t = convexTest(schema, modules);
    const response = await t.fetch("/api/internal-submit-feedback", post("/", report({ requestId: "VALUE IS SECRET" }), SECRET));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "INVALID_FEEDBACK", field: "requestId" });
    expect(text).not.toContain("SECRET");
  });

  test("maps a deleted account to a final 403", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("accountDeletions", {
      userId: "user_gone", userIdHash: "a".repeat(64), source: "self", status: "complete",
      step: "complete", dodoSubscriptionIds: [], startedAt: 1, updatedAt: 1,
    }));
    const response = await t.fetch("/api/internal-submit-feedback", post("/", report({
      authKind: "keyed", principalId: "user_gone", reporterKey: "principal:user_gone", ipHash: undefined,
    }), SECRET));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "ACCOUNT_DELETION_IN_PROGRESS" });
  });

  test("maps the reporter cap to 429", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
    const t = convexTest(schema, modules);
    for (let i = 0; i < FEEDBACK_REPORTER_HOURLY_CAP; i++) {
      await t.mutation(internal.agentFeedback.submit, report());
    }
    expect((await t.fetch("/api/internal-submit-feedback", post("/", report(), SECRET))).status).toBe(429);
  });
});
