import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Helpers (mirrors convex/__tests__/apiKeys.test.ts)
// ---------------------------------------------------------------------------

const NOW = Date.now();
const FUTURE = NOW + 86400000 * 30; // 30 days
const PAST = NOW - 86400000; // 1 day ago

const API_USER = { subject: "user-api", tokenIdentifier: "clerk|user-api" };
const PRO_USER = { subject: "user-pro", tokenIdentifier: "clerk|user-pro" };
const FREE_USER = { subject: "user-free", tokenIdentifier: "clerk|user-free" };
const OTHER_USER = { subject: "user-other", tokenIdentifier: "clerk|user-other" };

const SHARED_SECRET = "test-shared-secret";

async function seedProEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  opts: { validUntil?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "pro_monthly",
      features: getFeaturesForPlan("pro_monthly"),
      validUntil: opts.validUntil ?? FUTURE,
      updatedAt: NOW,
    });
  });
}

async function seedApiEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  opts: { validUntil?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "api_starter",
      features: getFeaturesForPlan("api_starter"),
      validUntil: opts.validUntil ?? FUTURE,
      updatedAt: NOW,
    });
  });
}

// ---------------------------------------------------------------------------
// issueProMcpToken (internal)
// ---------------------------------------------------------------------------

describe("issueProMcpToken", () => {
  test("succeeds for tier-1 (Pro) user", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const result = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
      clientId: "claude-desktop",
      name: "Connected via Claude Desktop",
    });

    expect(result.tokenId).toBeTruthy();

    // Verify row exists with revokedAt unset
    const row = await t.run(async (ctx) => ctx.db.get(result.tokenId));
    expect(row).toBeTruthy();
    expect(row?.userId).toBe("user-pro");
    expect(row?.clientId).toBe("claude-desktop");
    expect(row?.name).toBe("Connected via Claude Desktop");
    expect(row?.revokedAt).toBeUndefined();
    expect(row?.createdAt).toBeGreaterThan(0);
  });

  test("succeeds for tier-2 (API) user — Pro is the floor not exclusive", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const result = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-api",
    });
    expect(result.tokenId).toBeTruthy();
  });

  test("rejects tier-0 (free) user with PRO_REQUIRED", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "user-free" }),
    ).rejects.toThrow(/PRO_REQUIRED/);
  });

  test("rejects tier-1 user whose entitlement has lapsed", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro", { validUntil: PAST });

    await expect(
      t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "user-pro" }),
    ).rejects.toThrow(/PRO_REQUIRED/);
  });

  test("F5 convergence: 6 actives (race-leftover) → next issue trims to MAX", async () => {
    // Models the post-race state the F5 fix converges from: a brief
    // racing window left 6 active rows; the next issue call must trim
    // back to MAX (5) — that's the "eventually 5" guarantee.
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    // Manually seed 6 active rows (simulates the race outcome).
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 6; i++) {
        await ctx.db.insert("mcpProTokens", {
          userId: "user-pro",
          createdAt: now - (6 - i) * 1000, // oldest first
          name: `racing-slot-${i + 1}`,
        });
      }
    });

    // Next issue must converge: revoke 2 oldest, insert 1 new → 5 active.
    const seventh = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
      name: "post-race",
    });
    expect(seventh.tokenId).toBeTruthy();

    const rows = await t
      .withIdentity(PRO_USER)
      .query(api.mcpProTokens.listProMcpTokens, {});
    const active = rows.filter((r: any) => !r.revokedAt);
    expect(active).toHaveLength(5);
  });

  test("6th issue rotates oldest — caps active rows at 5", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
        userId: "user-pro",
        name: `slot-${i}`,
      });
      ids.push(r.tokenId);
    }

    // Sixth issue should rotate the oldest (slot-1) and return a new id
    const sixth = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
      name: "slot-6",
    });
    expect(sixth.tokenId).toBeTruthy();
    expect(ids).not.toContain(sixth.tokenId);

    // The oldest row must be revoked, NOT deleted (audit trail)
    const oldestRow = await t.run(async (ctx) => ctx.db.get(ids[0] as any));
    expect(oldestRow).toBeTruthy();
    expect(oldestRow?.revokedAt).toBeGreaterThan(0);

    // Active count is exactly 5
    const allRows = await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {});
    const active = allRows.filter((r: any) => !r.revokedAt);
    expect(active).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// validateProMcpToken (internal)
// ---------------------------------------------------------------------------

describe("validateProMcpToken", () => {
  test("returns {userId} for active row", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    const result = await t.query(internal.mcpProTokens.validateProMcpToken, {
      tokenId: issued.tokenId,
    });
    expect(result).toEqual({ userId: "user-pro" });
  });

  test("returns null for revoked row", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });
    await t.withIdentity(PRO_USER).mutation(api.mcpProTokens.revokeProMcpToken, {
      tokenId: issued.tokenId,
    });

    const result = await t.query(internal.mcpProTokens.validateProMcpToken, {
      tokenId: issued.tokenId,
    });
    expect(result).toBeNull();
  });

  test("returns null for non-existent tokenId (real-shape id)", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    // Issue then delete to obtain a syntactically valid but non-existent id
    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });
    await t.run(async (ctx) => ctx.db.delete(issued.tokenId));

    const result = await t.query(internal.mcpProTokens.validateProMcpToken, {
      tokenId: issued.tokenId,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeProMcpToken (public)
// ---------------------------------------------------------------------------

describe("revokeProMcpToken", () => {
  test("owner revoke sets revokedAt and subsequent validate returns null", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    const result = await t.withIdentity(PRO_USER).mutation(
      api.mcpProTokens.revokeProMcpToken,
      { tokenId: issued.tokenId },
    );
    expect(result).toEqual({ ok: true });

    const validated = await t.query(internal.mcpProTokens.validateProMcpToken, {
      tokenId: issued.tokenId,
    });
    expect(validated).toBeNull();
  });

  test("non-owner revoke throws NOT_FOUND (no leak)", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    await expect(
      t.withIdentity(OTHER_USER).mutation(api.mcpProTokens.revokeProMcpToken, {
        tokenId: issued.tokenId,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("double revoke throws ALREADY_REVOKED", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });
    const asPro = t.withIdentity(PRO_USER);
    await asPro.mutation(api.mcpProTokens.revokeProMcpToken, {
      tokenId: issued.tokenId,
    });

    await expect(
      asPro.mutation(api.mcpProTokens.revokeProMcpToken, { tokenId: issued.tokenId }),
    ).rejects.toThrow(/ALREADY_REVOKED/);
  });
});

// ---------------------------------------------------------------------------
// listProMcpTokens (public)
// ---------------------------------------------------------------------------

describe("listProMcpTokens", () => {
  test("returns empty array for user with zero rows", async () => {
    const t = convexTest(schema, modules);
    const rows = await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {});
    expect(rows).toEqual([]);
  });

  test("returns ALL rows (active + revoked) for transparency", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const a = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
      name: "active-one",
    });
    const b = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
      name: "to-be-revoked",
    });
    await t.withIdentity(PRO_USER).mutation(api.mcpProTokens.revokeProMcpToken, {
      tokenId: b.tokenId,
    });

    const rows = await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {});
    expect(rows).toHaveLength(2);
    expect(rows.find((r: any) => r.id === a.tokenId)?.revokedAt).toBeUndefined();
    expect(rows.find((r: any) => r.id === b.tokenId)?.revokedAt).toBeGreaterThan(0);
  });

  test("does not return other users' rows", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    await t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "user-pro" });

    const rows = await t.withIdentity(OTHER_USER).query(api.mcpProTokens.listProMcpTokens, {});
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// touchProMcpTokenLastUsed (internal) — debounce
// ---------------------------------------------------------------------------

describe("touchProMcpTokenLastUsed", () => {
  test("sets lastUsedAt on first call", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    await t.mutation(internal.mcpProTokens.touchProMcpTokenLastUsed, {
      tokenId: issued.tokenId,
    });

    const rows = await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {});
    const row = rows.find((r: any) => r.id === issued.tokenId);
    expect(row?.lastUsedAt).toBeGreaterThan(0);
  });

  test("debounces: second call within 5min does not bump lastUsedAt", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    await t.mutation(internal.mcpProTokens.touchProMcpTokenLastUsed, {
      tokenId: issued.tokenId,
    });
    const after1 = (await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {}))
      .find((r: any) => r.id === issued.tokenId)?.lastUsedAt;

    // Immediate second call should be debounced
    await t.mutation(internal.mcpProTokens.touchProMcpTokenLastUsed, {
      tokenId: issued.tokenId,
    });
    const after2 = (await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {}))
      .find((r: any) => r.id === issued.tokenId)?.lastUsedAt;

    expect(after1).toBe(after2);
  });

  test("no-op on revoked row (don't bump revoked tokens)", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });
    await t.withIdentity(PRO_USER).mutation(api.mcpProTokens.revokeProMcpToken, {
      tokenId: issued.tokenId,
    });

    // Should not throw and lastUsedAt must remain unset
    await t.mutation(internal.mcpProTokens.touchProMcpTokenLastUsed, {
      tokenId: issued.tokenId,
    });

    const rows = await t.withIdentity(PRO_USER).query(api.mcpProTokens.listProMcpTokens, {});
    const row = rows.find((r: any) => r.id === issued.tokenId);
    expect(row?.lastUsedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP routes (service-to-service via x-convex-shared-secret)
// ---------------------------------------------------------------------------

describe("HTTP route /api/internal-issue-pro-mcp-token", () => {
  beforeEach(() => {
    process.env.CONVEX_SERVER_SHARED_SECRET = SHARED_SECRET;
  });
  afterEach(() => {
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
  });

  test("rejects missing shared-secret with 401", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-issue-pro-mcp-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-pro" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects wrong shared-secret with 401", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-issue-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": "wrong",
      },
      body: JSON.stringify({ userId: "user-pro" }),
    });
    expect(res.status).toBe(401);
  });

  test("happy path: tier-1 user → 200 with tokenId", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const res = await t.fetch("/api/internal-issue-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ userId: "user-pro", clientId: "cl", name: "n" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokenId?: string };
    expect(body.tokenId).toBeTruthy();
  });

  test("tier-0 → 403 PRO_REQUIRED", async () => {
    const t = convexTest(schema, modules);

    const res = await t.fetch("/api/internal-issue-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ userId: "user-free" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("PRO_REQUIRED");
  });
});

describe("HTTP route /api/internal-validate-pro-mcp-token", () => {
  beforeEach(() => {
    process.env.CONVEX_SERVER_SHARED_SECRET = SHARED_SECRET;
  });
  afterEach(() => {
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
  });

  test("rejects missing shared-secret with 401", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-validate-pro-mcp-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId: "anything" }),
    });
    expect(res.status).toBe(401);
  });

  test("happy path: active token → {userId}", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    const res = await t.fetch("/api/internal-validate-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ tokenId: issued.tokenId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId?: string } | null;
    expect(body).toEqual({ userId: "user-pro" });

    // The validate HTTP route schedules a fire-and-forget touch via
    // ctx.scheduler.runAfter(0, ...). Drain it deterministically with
    // fake timers so the lastUsedAt write doesn't escape the transaction
    // window and surface as an unhandled rejection during teardown.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });

  test("revoked token → null", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });
    await t.withIdentity(PRO_USER).mutation(api.mcpProTokens.revokeProMcpToken, {
      tokenId: issued.tokenId,
    });

    const res = await t.fetch("/api/internal-validate-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ tokenId: issued.tokenId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();

    // Defensive: revoked path returns null and skips scheduling, but
    // drain regardless to keep this test resilient to future edits.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });
});

describe("HTTP route /api/internal-revoke-pro-mcp-token", () => {
  beforeEach(() => {
    process.env.CONVEX_SERVER_SHARED_SECRET = SHARED_SECRET;
  });
  afterEach(() => {
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
  });

  test("rejects missing shared-secret with 401", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-revoke-pro-mcp-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-pro", tokenId: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("owner-matched revoke → 200", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    const res = await t.fetch("/api/internal-revoke-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ userId: "user-pro", tokenId: issued.tokenId }),
    });
    expect(res.status).toBe(200);
  });

  test("non-owner userId mismatch → 404 NOT_FOUND", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const issued = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-pro",
    });

    const res = await t.fetch("/api/internal-revoke-pro-mcp-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ userId: "user-other", tokenId: issued.tokenId }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration: userApiKeys table is untouched
// ---------------------------------------------------------------------------

describe("integration: userApiKeys table untouched", () => {
  test("issuing a Pro MCP token does not create a userApiKeys row", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    await t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "user-pro" });

    // Inspect the underlying table directly
    const apiKeys = await t.run(async (ctx) =>
      ctx.db
        .query("userApiKeys")
        .withIndex("by_userId", (q) => q.eq("userId", "user-pro"))
        .collect(),
    );
    expect(apiKeys).toEqual([]);
  });
});
