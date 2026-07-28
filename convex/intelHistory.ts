import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

/**
 * Append-only historical intelligence memory (#5694).
 *
 * The live seeder snapshots in Redis overwrite themselves every run, so
 * "what happened in this country three months ago" is unanswerable from
 * them. This module is the durable store behind those snapshots: seeders
 * append the events they published, reads come back either chronologically
 * (`timeline`) or by semantic similarity (`search`), and a daily cron ages
 * rows out (`prune`).
 *
 * Everything here is `internal*` on purpose. The only ways in are the three
 * secret-guarded HTTP routes in convex/http.ts — `/relay/intel-history`
 * (ingest, Railway seeders), `/api/internal-intel-timeline` and
 * `/api/internal-intel-search` (reads, Vercel edge). No client-facing
 * function touches this table.
 */

/**
 * Dimension of every stored and query vector. MUST equal `EMBED_DIMS` in
 * scripts/lib/brief-dedup-consts.mjs (openai/text-embedding-3-small@512) and
 * the `dimensions` of the `by_embedding` vector index in convex/schema.ts.
 * Changing it is a table migration plus a full re-embed, never an edit here —
 * see the schema comment on `intelHistory`.
 */
export const INTEL_HISTORY_EMBED_DIMS = 512;

/**
 * Per-call ingest cap. Each record carries a 512-float vector (~4KB before
 * encoding), so this bounds both the mutation's write set and the request
 * body the relay route has to parse. Seeders chunk larger runs.
 */
export const INTEL_HISTORY_MAX_APPEND_RECORDS = 100;

/**
 * Documented retention policy: history older than this is deleted by the
 * `intel-history-prune` daily cron. 180 days is the window the historical
 * comparisons are specified against ("versus six months ago"); it is also
 * what keeps the vector index — the expensive part of this table — bounded.
 */
export const INTEL_HISTORY_RETENTION_DAYS = 180;

const RETENTION_MS = INTEL_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Per-run delete cap, deliberately far below the apiPlanLimit prune's 500:
 * each row here carries a 512-float embedding, so 100 deletes stay well
 * inside Convex's per-mutation write limit. A larger backlog drains through
 * the self-reschedule below rather than over successive daily runs.
 */
const PRUNE_BATCH = 100;

const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 200;

const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 64;

/**
 * When a read has to post-filter (a field that could not be pushed into the
 * index, or an occurredAt range on the vector path), fetch this multiple of
 * the caller's limit so the post-filter still has something to return.
 * Bounded by TIMELINE_MAX_SCAN / VECTOR_SEARCH_MAX_LIMIT — this widens the
 * read, it never unbounds it.
 */
const POST_FILTER_OVERFETCH = 4;

/** Hard ceiling on documents a single `timeline` call may read. */
const TIMELINE_MAX_SCAN = 800;

/** Convex's own ceiling on `vectorSearch` limit. */
const VECTOR_SEARCH_MAX_LIMIT = 256;

/** The single pre-seeded OCC document used to serialize low-frequency appends. */
const APPEND_LOCK_KEY = "intel-history-append";

/**
 * Read the pre-seeded append lock or fail closed when deploy initialization
 * was skipped. An empty dedupe-key index range is not a document-backed OCC
 * dependency, so this document must be read and patched in every append
 * transaction before dedupe checks begin.
 */
async function readAppendLockOrThrow(
  ctx: MutationCtx,
): Promise<Doc<"intelHistoryAppendLocks">> {
  const lock = await ctx.db
    .query("intelHistoryAppendLocks")
    .withIndex("by_lockKey", (q) => q.eq("lockKey", APPEND_LOCK_KEY))
    .first();
  if (!lock) {
    console.error(
      JSON.stringify({
        breadcrumb: "intel_history_append_lock_not_seeded",
        lockKey: APPEND_LOCK_KEY,
      }),
    );
    throw new ConvexError({ kind: "APPEND_LOCK_NOT_SEEDED" });
  }
  return lock;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Projection returned by every read path.
 *
 * Two things are deliberately dropped: `embedding` (2KB+ of float noise no
 * caller can use, and the single biggest contributor to response size) and
 * the raw `_id`, replaced by a plain `id` string so the REST/MCP layers above
 * expose a stable opaque handle rather than a Convex document reference.
 *
 * Absent optionals are simply absent — Convex strips `undefined` object
 * fields during serialization rather than emitting nulls.
 */
function projectRecord(doc: Doc<"intelHistory">) {
  return {
    id: doc._id as string,
    domain: doc.domain,
    resource: doc.resource,
    country: doc.country,
    category: doc.category,
    title: doc.title,
    summary: doc.summary,
    sourceUrl: doc.sourceUrl,
    occurredAt: doc.occurredAt,
    ingestedAt: doc.ingestedAt,
    runId: doc.runId,
    dedupeKey: doc.dedupeKey,
  };
}

export type IntelHistoryRecord = ReturnType<typeof projectRecord>;

/** A `search` hit: the projection plus its cosine similarity to the query. */
export type IntelHistorySearchRecord = IntelHistoryRecord & { _score: number };

/**
 * Reject a vector that is the wrong length or carries a non-finite component.
 * The length check mirrors what Convex enforces on insert; the finiteness
 * check does not exist server-side and matters more: a single NaN silently
 * poisons the cosine similarity of every future search that ranks against
 * that row, and there is no error to trace it back from.
 */
function assertEmbedding(embedding: number[], context: string): void {
  if (embedding.length !== INTEL_HISTORY_EMBED_DIMS) {
    throw new Error(
      `${context}: embedding must have ${INTEL_HISTORY_EMBED_DIMS} dimensions, got ${embedding.length}`,
    );
  }
  for (const component of embedding) {
    if (!Number.isFinite(component)) {
      throw new Error(`${context}: embedding components must be finite numbers`);
    }
  }
}

const appendRecordValidator = v.object({
  dedupeKey: v.string(),
  country: v.optional(v.string()),
  category: v.optional(v.string()),
  title: v.string(),
  summary: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  occurredAt: v.number(),
  embedding: v.array(v.float64()),
});

/**
 * Append a run's events. Idempotent on `dedupeKey`: a seeder that republishes
 * the same event (every run does — the live snapshot is a rolling window)
 * adds nothing and reports it as skipped.
 *
 * The existence check and the insert share this mutation's transaction. Doing
 * the check via `ctx.runMutation` would put it in a SEPARATE transaction and
 * reopen exactly the race the dedupe is there to close.
 */
export const append = internalMutation({
  args: {
    domain: v.string(),
    resource: v.string(),
    runId: v.string(),
    records: v.array(appendRecordValidator),
  },
  handler: async (ctx, args) => {
    if (args.records.length > INTEL_HISTORY_MAX_APPEND_RECORDS) {
      throw new Error(
        `intelHistory.append: at most ${INTEL_HISTORY_MAX_APPEND_RECORDS} records per call, got ${args.records.length}`,
      );
    }
    // Validate the whole batch up front. A throw rolls the transaction back
    // either way, but failing before the first write keeps the error about
    // the caller's payload rather than about a partially applied run.
    for (const rec of args.records) {
      assertEmbedding(rec.embedding, "intelHistory.append");
    }

    // Must precede all dedupe reads. Patching an already-existing document
    // makes concurrent first-seen appends conflict and retry against the
    // winning transaction's inserted rows.
    const appendLock = await readAppendLockOrThrow(ctx);
    await ctx.db.patch(appendLock._id, { lastTouchedAt: Date.now() });

    const ingestedAt = Date.now();
    let inserted = 0;
    let skipped = 0;
    // Within-batch dedupe: two records sharing a key in one payload would
    // both miss the index lookup (neither is committed yet at read time).
    const seenInBatch = new Set<string>();
    const candidates = [];
    for (const rec of args.records) {
      if (seenInBatch.has(rec.dedupeKey)) {
        skipped += 1;
        continue;
      }
      seenInBatch.add(rec.dedupeKey);
      candidates.push(rec);
    }

    // The existence checks are independent of each other, so issue them
    // together: this is up to 100 indexed reads, and running them serially
    // holds the mutation's read set open far longer than needed while three
    // seeders write to this table on overlapping schedules.
    const existing = await Promise.all(
      candidates.map((rec) =>
        ctx.db
          .query("intelHistory")
          .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", rec.dedupeKey))
          .first(),
      ),
    );

    for (const [index, rec] of candidates.entries()) {
      if (existing[index] !== null) {
        skipped += 1;
        continue;
      }

      await ctx.db.insert("intelHistory", {
        domain: args.domain,
        resource: args.resource,
        runId: args.runId,
        country: rec.country,
        category: rec.category,
        title: rec.title,
        summary: rec.summary,
        sourceUrl: rec.sourceUrl,
        occurredAt: rec.occurredAt,
        ingestedAt,
        dedupeKey: rec.dedupeKey,
        embedding: rec.embedding,
      });
      inserted += 1;
    }

    return { inserted, skipped };
  },
});

/**
 * Idempotently initialize the document-backed append lock after deployment.
 * A missing lock is an operator/deploy failure, never a fallback to unsafe
 * index-range-only idempotency; `append` throws APPEND_LOCK_NOT_SEEDED until
 * this succeeds.
 */
export const _seedAppendLock = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ seeded: number }> => {
    const existing = await ctx.db
      .query("intelHistoryAppendLocks")
      .withIndex("by_lockKey", (q) => q.eq("lockKey", APPEND_LOCK_KEY))
      .first();
    if (existing) return { seeded: 0 };
    await ctx.db.insert("intelHistoryAppendLocks", {
      lockKey: APPEND_LOCK_KEY,
      lastTouchedAt: Date.now(),
    });
    return { seeded: 1 };
  },
});

/**
 * Chronological read. At least one of `domain` / `country` is required: the
 * only other option would be a table-wide scan ordered by `occurredAt`, which
 * has no index and no bounded cost. The REST layer rejects the unscoped case
 * too, so this throw is the backstop, not the user-facing error.
 *
 * `domain` wins the index when both are given, matching `search` below so the
 * two read paths agree; `country` is then post-filtered from a window
 * over-fetched by POST_FILTER_OVERFETCH. When that candidate window is full,
 * `partial` tells callers it may contain more country matches beyond the
 * bounded scan; they must not treat a short or empty page as exhaustive.
 */
export const timeline = internalQuery({
  args: {
    domain: v.optional(v.string()),
    country: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.domain === undefined && args.country === undefined) {
      throw new Error(
        "intelHistory.timeline: at least one of domain or country is required",
      );
    }

    const limit = clamp(args.limit ?? TIMELINE_DEFAULT_LIMIT, 1, TIMELINE_MAX_LIMIT);
    const { from, to } = args;

    // Over-fetch only when something is left to filter after the index range.
    const needsPostFilter = args.domain !== undefined && args.country !== undefined;
    const scanLimit = needsPostFilter
      ? Math.min(limit * POST_FILTER_OVERFETCH, TIMELINE_MAX_SCAN)
      : limit;

    // Both indexes are (scopeField, occurredAt), so the occurredAt bounds are
    // part of the index range rather than a post-read filter. The duplicated
    // branches are the price of that: `withIndex` types the range builder
    // against the specific index, so one shared helper cannot serve both.
    const docs =
      args.domain !== undefined
        ? await ctx.db
            .query("intelHistory")
            .withIndex("by_domain_occurredAt", (q) => {
              const scoped = q.eq("domain", args.domain as string);
              if (from !== undefined && to !== undefined) {
                return scoped.gte("occurredAt", from).lte("occurredAt", to);
              }
              if (from !== undefined) return scoped.gte("occurredAt", from);
              if (to !== undefined) return scoped.lte("occurredAt", to);
              return scoped;
            })
            .order("desc")
            .take(scanLimit)
        : await ctx.db
            .query("intelHistory")
            .withIndex("by_country_occurredAt", (q) => {
              const scoped = q.eq("country", args.country as string);
              if (from !== undefined && to !== undefined) {
                return scoped.gte("occurredAt", from).lte("occurredAt", to);
              }
              if (from !== undefined) return scoped.gte("occurredAt", from);
              if (to !== undefined) return scoped.lte("occurredAt", to);
              return scoped;
            })
            .order("desc")
            .take(scanLimit);

    const matched = needsPostFilter
      ? docs.filter((doc) => doc.country === args.country)
      : docs;

    return {
      records: matched.slice(0, limit).map(projectRecord),
      partial: needsPostFilter && docs.length === scanLimit,
    };
  },
});

/**
 * Hydrate vector-search hits. `ctx.vectorSearch` returns ids and scores only,
 * so the action reads the documents back through this query.
 *
 * Input order is preserved (the caller's order IS the relevance order) and
 * ids that no longer resolve are dropped rather than throwing — a prune tick
 * between the search and the hydration is normal, not an error.
 */
export const getByIds = internalQuery({
  args: { ids: v.array(v.id("intelHistory")) },
  handler: async (ctx, args) => {
    if (args.ids.length > VECTOR_SEARCH_MAX_LIMIT) {
      throw new Error(
        `intelHistory.getByIds: at most ${VECTOR_SEARCH_MAX_LIMIT} ids per call, got ${args.ids.length}`,
      );
    }
    // Independent reads on a user-facing search path — issue them together
    // rather than serially. Promise.all resolves in input order, which IS the
    // relevance order the caller depends on.
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter((doc) => doc !== null).map((doc) => projectRecord(doc));
  },
});

/**
 * Semantic read. Runs as an action because `ctx.vectorSearch` is only
 * available there.
 *
 * FILTER PUSHDOWN — Convex's vector filter builder exposes `eq` and `or` and
 * nothing else, so `domain AND country` cannot be expressed. `domain` is
 * pushed into the index (matching `timeline`'s index preference so the two
 * read paths agree) and `country` is post-filtered, as is the `occurredAt`
 * range, which the vector index cannot express at all. Both post-filters run
 * after the top-k cut, so the query over-fetches by POST_FILTER_OVERFETCH
 * whenever one applies. If that bounded candidate window fills, `partial`
 * marks the response as potentially incomplete rather than presenting a
 * false-empty or short result as exhaustive. See the final note in
 * convex/schema.ts.
 */
export const search = internalAction({
  args: {
    embedding: v.array(v.float64()),
    domain: v.optional(v.string()),
    country: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    limit: v.optional(v.number()),
    minScore: v.optional(v.number()),
  },
  // The return type is annotated, not inferred. `getByIds` lives in THIS
  // module, so `internal.intelHistory.getByIds` resolves through the module's
  // own type — inferring the handler's return would be circular (TS7022/7023),
  // and TypeScript resolves such cycles by degrading the whole `internal`
  // surface to `any`, which silently un-types every OTHER module's
  // self-referential `ctx.runQuery` too.
  handler: async (
    ctx,
    args,
  ): Promise<{ records: IntelHistorySearchRecord[]; partial: boolean }> => {
    assertEmbedding(args.embedding, "intelHistory.search");

    const limit = clamp(args.limit ?? SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const pushedDown =
      args.domain !== undefined
        ? "domain"
        : args.country !== undefined
          ? "country"
          : null;
    const needsPostFilter =
      (pushedDown === "domain" && args.country !== undefined) ||
      args.from !== undefined ||
      args.to !== undefined;
    const vectorLimit = Math.min(
      needsPostFilter ? limit * POST_FILTER_OVERFETCH : limit,
      VECTOR_SEARCH_MAX_LIMIT,
    );

    const hits = await ctx.vectorSearch("intelHistory", "by_embedding", {
      vector: args.embedding,
      limit: vectorLimit,
      ...(pushedDown === "domain"
        ? { filter: (q) => q.eq("domain", args.domain as string) }
        : pushedDown === "country"
          ? { filter: (q) => q.eq("country", args.country as string) }
          : {}),
    });

    if (hits.length === 0) return { records: [], partial: false };

    const scoreById = new Map(hits.map((hit) => [hit._id as string, hit._score]));
    const hydrated: IntelHistoryRecord[] = await ctx.runQuery(
      internal.intelHistory.getByIds,
      { ids: hits.map((hit) => hit._id) },
    );

    const records = hydrated
      .filter((rec) => {
        if (pushedDown === "domain" && args.country !== undefined) {
          if (rec.country !== args.country) return false;
        }
        if (args.from !== undefined && rec.occurredAt < args.from) return false;
        if (args.to !== undefined && rec.occurredAt > args.to) return false;
        return true;
      })
      .filter((rec) => {
        const score = scoreById.get(rec.id) ?? 0;
        return args.minScore === undefined || score >= args.minScore;
      })
      .slice(0, limit)
      .map((rec) => ({ ...rec, _score: scoreById.get(rec.id) ?? 0 }));

    return { records, partial: needsPostFilter && hits.length === vectorLimit };
  },
});

/**
 * Retention prune. Ages rows out by `ingestedAt`, not `occurredAt`, so a
 * backfill of genuinely old events survives its first night.
 *
 * Modelled on `pruneApiPlanLimitData` (convex/apiPlanLimitNotices.ts): the
 * per-run batch keeps one invocation inside Convex's write limit, and a full
 * batch means more aged rows remain, so the mutation reschedules itself
 * immediately — carrying the SAME resolved `now` so the cutoff stays fixed
 * across the chain. Without the self-drain, one daily run would delete at
 * most `batch` rows and the first prune 180 days after launch would take
 * weeks to clear.
 */
export const prune = internalMutation({
  args: {
    now: v.optional(v.number()),
    retentionMs: v.optional(v.number()),
    // Per-run delete cap. Optional so tests can drive the drain without
    // seeding PRUNE_BATCH rows.
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const cutoff = now - (args.retentionMs ?? RETENTION_MS);
    // Floor of 1, and non-finite falls back to the default rather than
    // propagating: a batch of 0 makes `take(0)` return [] and the
    // `stale.length >= batch` check below read 0 >= 0 as "a full batch", so the
    // mutation would reschedule itself forever, deleting nothing. The cron
    // passes {}, but this is operator-callable and `limit: 0` is a natural
    // thing to type when probing the drain.
    const requestedBatch = args.limit;
    const batch = Number.isFinite(requestedBatch)
      ? Math.max(1, Math.floor(requestedBatch as number))
      : PRUNE_BATCH;

    const stale = await ctx.db
      .query("intelHistory")
      .withIndex("by_ingestedAt", (q) => q.lt("ingestedAt", cutoff))
      .take(batch);
    for (const doc of stale) {
      await ctx.db.delete(doc._id);
    }

    const rescheduled = stale.length >= batch;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.intelHistory.prune, {
        now,
        retentionMs: args.retentionMs,
        limit: batch,
      });
    }

    return { deleted: stale.length, rescheduled };
  },
});
