/**
 * Counts of new sign-ups, API keys and OAuth MCP grants by AI client source.
 *
 * Read-only and internal: run it from the Convex dashboard or the CLI, e.g.
 *
 *   npx convex run agentSources:countBySource '{"sinceMs": 1792195200000}'
 *
 * Sources are written by shared/agent-client-source.js callers:
 *   - users.signupSource       first-touch `?ref=agent-<client>` at account creation
 *   - userApiKeys.source       same first-touch ref when the key was created
 *   - mcpProTokens.clientSource OAuth client_name of the granted MCP client
 *
 * Each table is scanned on the built-in `by_creation_time` index from `sinceMs`
 * and capped at MAX_ROWS_PER_TABLE; `truncated` says when a window was cut, so
 * narrow the window instead of trusting a partial count.
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

const MAX_ROWS_PER_TABLE = 8000;
const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;
/** Bucket for rows written before this field existed, or with no agent link. */
export const NO_SOURCE = "none";

type Tally = { total: number; bySource: Record<string, number>; truncated: boolean };

function tally<T>(rows: T[], sourceOf: (row: T) => string | undefined, truncated: boolean): Tally {
  const bySource: Record<string, number> = {};
  for (const row of rows) {
    const key = sourceOf(row) || NO_SOURCE;
    bySource[key] = (bySource[key] ?? 0) + 1;
  }
  return { total: rows.length, bySource, truncated };
}

export const countBySource = internalQuery({
  args: {
    sinceMs: v.number(),
    untilMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const untilMs = args.untilMs ?? Date.now();
    if (!Number.isFinite(args.sinceMs) || args.sinceMs >= untilMs) {
      throw new Error("sinceMs must be a finite time before untilMs");
    }
    if (untilMs - args.sinceMs > MAX_WINDOW_MS) {
      throw new Error("window too large; query at most 400 days at a time");
    }

    const users = await ctx.db
      .query("users")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs).lt("_creationTime", untilMs))
      .take(MAX_ROWS_PER_TABLE + 1);
    const apiKeys = await ctx.db
      .query("userApiKeys")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs).lt("_creationTime", untilMs))
      .take(MAX_ROWS_PER_TABLE + 1);
    const mcpGrants = await ctx.db
      .query("mcpProTokens")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs).lt("_creationTime", untilMs))
      .take(MAX_ROWS_PER_TABLE + 1);

    return {
      sinceMs: args.sinceMs,
      untilMs,
      signups: tally(users.slice(0, MAX_ROWS_PER_TABLE), (row) => row.signupSource, users.length > MAX_ROWS_PER_TABLE),
      apiKeys: tally(apiKeys.slice(0, MAX_ROWS_PER_TABLE), (row) => row.source, apiKeys.length > MAX_ROWS_PER_TABLE),
      mcpGrants: tally(mcpGrants.slice(0, MAX_ROWS_PER_TABLE), (row) => row.clientSource, mcpGrants.length > MAX_ROWS_PER_TABLE),
    };
  },
});
