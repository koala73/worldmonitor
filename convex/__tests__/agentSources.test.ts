/**
 * Sign-up source tracking: which AI client a new user, API key or OAuth MCP
 * grant came from, and the count query that reports it.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import { PAGE_SIZE } from "../agentSources";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-agent-src", tokenIdentifier: "clerk|user-agent-src", email: "a@example.com" };
const API_USER = { subject: "user-agent-api", tokenIdentifier: "clerk|user-agent-api" };

const userRow = (t: ReturnType<typeof convexTest>, userId: string) =>
  t.run(async (ctx) =>
    await ctx.db.query("users").withIndex("by_userId", (q) => q.eq("userId", userId)).unique(),
  );

describe("users.ensureRecord sign-up source", () => {
  test("stamps the agent ref and its bucket when the row is created", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      signupRef: "agent-claude",
    });
    const row = await userRow(t, USER.subject);
    expect(row?.signupRef).toBe("agent-claude");
    expect(row?.signupSource).toBe("claude");
  });

  test("never rewrites the source on a later session", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.users.ensureRecord, { localeTag: "en-US", localePrimary: "en" });
    await asUser.mutation(api.users.ensureRecord, { localeTag: "fr-FR", localePrimary: "fr", signupRef: "agent-cursor" });
    const row = await userRow(t, USER.subject);
    expect(row?.signupRef).toBeUndefined();
    expect(row?.signupSource).toBeUndefined();
  });

  test("drops an invalid or affiliate ref instead of failing sign-up", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      signupRef: "AFF-CODE-1",
    });
    const row = await userRow(t, USER.subject);
    expect(row).toBeTruthy();
    expect(row?.signupRef).toBeUndefined();
    expect(row?.signupSource).toBeUndefined();
  });
});

describe("apiKeys.createApiKey source", () => {
  const createKey = async (t: ReturnType<typeof convexTest>) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: API_USER.subject,
        planKey: "api_starter",
        features: getFeaturesForPlan("api_starter"),
        validUntil: Date.now() + 86400000 * 30,
        updatedAt: Date.now(),
      });
    });
    const { id } = await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, {
      name: "agent key",
      keyPrefix: "wm_a1b2c",
      keyHash: "a1b2c".repeat(13).slice(0, 64),
    });
    return t.run(async (ctx) => ctx.db.get(id));
  };

  test("inherits the owner's sign-up source", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(API_USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      signupRef: "agent-gemini",
    });
    const row = await createKey(t);
    expect(row?.sourceRef).toBe("agent-gemini");
    expect(row?.source).toBe("gemini");
  });

  test("records no source for an account without one", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(API_USER).mutation(api.users.ensureRecord, { localeTag: "en-US", localePrimary: "en" });
    const row = await createKey(t);
    expect(row?.sourceRef).toBeUndefined();
    expect(row?.source).toBeUndefined();
  });

  test("rejects a client-supplied source", async () => {
    const t = convexTest(schema, modules);
    await expect(t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, {
      name: "agent key",
      keyPrefix: "wm_a1b2c",
      keyHash: "a1b2c".repeat(13).slice(0, 64),
      sourceRef: "agent-claude",
    } as never)).rejects.toThrow(/sourceRef/);
  });
});

describe("mcpProTokens.issueProMcpToken client source", () => {
  test("classifies the OAuth client the grant was issued to", async () => {
    const t = convexTest(schema, modules);
    const { tokenId } = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-mcp",
      clientId: "client-1",
      name: "Connected via ChatGPT",
    });
    const row = await t.run(async (ctx) => ctx.db.get(tokenId));
    expect(row?.clientSource).toBe("chatgpt");
  });

  test("leaves the field unset for the unknown-client placeholder", async () => {
    const t = convexTest(schema, modules);
    const { tokenId } = await t.mutation(internal.mcpProTokens.issueProMcpToken, {
      userId: "user-mcp-3",
      name: "Connected via Unknown Client",
    });
    const row = await t.run(async (ctx) => ctx.db.get(tokenId));
    expect(row?.clientSource).toBeUndefined();
  });

  test("leaves the field unset when there is no client name", async () => {
    const t = convexTest(schema, modules);
    const { tokenId } = await t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "user-mcp-2" });
    const row = await t.run(async (ctx) => ctx.db.get(tokenId));
    expect(row?.clientSource).toBeUndefined();
  });
});

describe("agentSources.countBySource", () => {
  test("counts each table by source inside the window, with no source as none", async () => {
    const t = convexTest(schema, modules);
    const since = Date.now() - 1000;
    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      signupRef: "agent-grok-bot",
    });
    await t.withIdentity({ subject: "u2", tokenIdentifier: "clerk|u2" }).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });
    await t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "u3", name: "Connected via Claude" });
    await t.mutation(internal.mcpProTokens.issueProMcpToken, { userId: "u4", name: "Connected via Cursor" });

    const result = await t.action(internal.agentSources.countBySource, { sinceMs: since, untilMs: Date.now() + 1000 });
    expect(result.signups).toEqual({ total: 2, bySource: { "grok-bot": 1, none: 1 }, truncated: false });
    expect(result.apiKeys).toEqual({ total: 0, bySource: {}, truncated: false });
    expect(result.mcpGrants).toEqual({ total: 2, bySource: { claude: 1, cursor: 1 }, truncated: false });

    const empty = await t.action(internal.agentSources.countBySource, { sinceMs: since - 10_000, untilMs: since });
    expect(empty.signups.total).toBe(0);
  });

  test("pages through more rows than one query reads", async () => {
    const t = convexTest(schema, modules);
    const since = Date.now() - 1000;
    const rows = 2 * PAGE_SIZE + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < rows; i++) {
        await ctx.db.insert("mcpProTokens", { userId: `bulk-${i}`, createdAt: Date.now(), ...(i % 2 ? { clientSource: "claude" } : {}) });
      }
    });
    const result = await t.action(internal.agentSources.countBySource, { sinceMs: since, untilMs: Date.now() + 1000 });
    expect(result.mcpGrants).toEqual({
      total: rows,
      bySource: { claude: PAGE_SIZE + 3, none: PAGE_SIZE + 4 },
      truncated: false,
    });
  });

  test("rejects an inverted or oversized window", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await expect(t.action(internal.agentSources.countBySource, { sinceMs: now, untilMs: now - 1 })).rejects.toThrow(/before untilMs/);
    await expect(t.action(internal.agentSources.countBySource, { sinceMs: 0, untilMs: now })).rejects.toThrow(/window too large/);
  });
});
