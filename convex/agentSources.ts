/**
 * Counts of new sign-ups, API keys and OAuth MCP grants by AI client source.
 *
 * Read-only and internal: run it from the Convex dashboard or the CLI, e.g.
 *
 *   npx convex run agentSources:countBySource '{"sinceMs": 1792195200000}'
 *
 * Sources are written by shared/agent-client-source.js callers:
 *   - users.signupSource       first-touch `?ref=agent-<client>` at account creation
 *   - userApiKeys.source       the owner's users.signupSource when the key was created
 *   - mcpProTokens.clientSource OAuth client_name of the granted MCP client
 *
 * countBySource is an action that pages each table on the built-in
 * `by_creation_time` index through pageSources, one bounded query per page, so
 * no single query nears Convex's per-query document or bytes-read limits
 * however many rows the window holds. Each page returns only the per-source
 * counts, never the documents. `truncated` says a table hit MAX_PAGES_PER_TABLE;
 * narrow the window instead of trusting a partial count.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";

/** Rows read per query. Small enough that full users rows stay far under the bytes-read limit. */
export const PAGE_SIZE = 500;
/** Pages per table per run: 1,000 pages is 500,000 rows. */
export const MAX_PAGES_PER_TABLE = 1000;
const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;
/** Bucket for rows written before this field existed, or with no agent link. */
export const NO_SOURCE = "none";

const sourceTable = v.union(v.literal("users"), v.literal("userApiKeys"), v.literal("mcpProTokens"));
type SourceTable = "users" | "userApiKeys" | "mcpProTokens";
type Tally = { total: number; bySource: Record<string, number>; truncated: boolean };

function sourceOf(table: SourceTable, row: { signupSource?: string; source?: string; clientSource?: string }): string {
  const source = table === "users" ? row.signupSource : table === "userApiKeys" ? row.source : row.clientSource;
  return source || NO_SOURCE;
}

/** One page of one table, reduced to per-source counts. */
export const pageSources = internalQuery({
  args: {
    table: sourceTable,
    sinceMs: v.number(),
    untilMs: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query(args.table)
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs).lt("_creationTime", args.untilMs))
      .paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
    const bySource: Record<string, number> = {};
    for (const row of page.page) {
      const key = sourceOf(args.table, row);
      bySource[key] = (bySource[key] ?? 0) + 1;
    }
    return { count: page.page.length, bySource, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const countBySource = internalAction({
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

    const countTable = async (table: SourceTable): Promise<Tally> => {
      const tally: Tally = { total: 0, bySource: {}, truncated: false };
      let cursor: string | null = null;
      for (let pages = 0; ; pages++) {
        if (pages === MAX_PAGES_PER_TABLE) {
          tally.truncated = true;
          return tally;
        }
        const page: { count: number; bySource: Record<string, number>; continueCursor: string; isDone: boolean } =
          await ctx.runQuery(internal.agentSources.pageSources, { table, sinceMs: args.sinceMs, untilMs, cursor });
        tally.total += page.count;
        for (const [source, n] of Object.entries(page.bySource)) {
          tally.bySource[source] = (tally.bySource[source] ?? 0) + n;
        }
        if (page.isDone) return tally;
        cursor = page.continueCursor;
      }
    };

    return {
      sinceMs: args.sinceMs,
      untilMs,
      signups: await countTable("users"),
      apiKeys: await countTable("userApiKeys"),
      mcpGrants: await countTable("mcpProTokens"),
    };
  },
});
