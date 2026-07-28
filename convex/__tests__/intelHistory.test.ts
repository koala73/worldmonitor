import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import {
  INTEL_HISTORY_EMBED_DIMS,
  INTEL_HISTORY_MAX_APPEND_RECORDS,
  INTEL_HISTORY_RETENTION_DAYS,
  TIMELINE_MAX_LIMIT,
} from "../intelHistory";

const modules = import.meta.glob("../**/*.ts");

const RELAY_SECRET = "test-relay-secret-intel-history-8f2a91";
const CONVEX_SECRET = "test-convex-secret-intel-history-91bd42";
const NOW = 1_780_000_000_000;
const DAY = 86_400_000;
const DIMS = INTEL_HISTORY_EMBED_DIMS;

/**
 * Unit vector along `axis`, optionally tilted toward the next axis. Cosine
 * similarity against `unitVector(0)` is then exactly 1 for axis 0, 0 for any
 * other pure axis, and 1/sqrt(1+tilt^2) for a tilted axis-0 vector — so score
 * ordering in the vector-search tests is arithmetic, not luck.
 */
function unitVector(axis: number, tilt = 0): number[] {
  const vec = new Array<number>(DIMS).fill(0);
  vec[axis] = 1;
  if (tilt !== 0) vec[(axis + 1) % DIMS] = tilt;
  return vec;
}

type AppendRecord = {
  dedupeKey: string;
  country?: string;
  category?: string;
  title: string;
  summary?: string;
  sourceUrl?: string;
  occurredAt: number;
  embedding: number[];
};

function record(overrides: Partial<AppendRecord> = {}): AppendRecord {
  return {
    dedupeKey: "dk-1",
    title: "Shelling reported near Kharkiv",
    occurredAt: NOW - DAY,
    embedding: unitVector(0),
    ...overrides,
  };
}

function appendArgs(
  records: AppendRecord[],
  overrides: { domain?: string; resource?: string; runId?: string } = {},
) {
  return {
    domain: "conflict",
    resource: "conflict-events",
    runId: "run-1",
    records,
    ...overrides,
  };
}

/** Insert straight to the table, bypassing the mutation, for read-path setup. */
async function seed(
  t: ReturnType<typeof convexTest>,
  rows: Array<Record<string, unknown>>,
) {
  await t.run(async (ctx) => {
    for (const row of rows) {
      await ctx.db.insert("intelHistory", {
        domain: "conflict",
        resource: "conflict-events",
        title: "seeded",
        ingestedAt: NOW,
        runId: "run-seed",
        embedding: unitVector(0),
        ...row,
      } as never);
    }
  });
}

/** Append intentionally fails closed unless deploy-style lock seeding ran. */
async function intelHistoryAppendTest() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.intelHistory._seedAppendLock, {});
  return t;
}

describe("intelHistory.append", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  test("inserts records stamped with the run-level fields and ingestedAt", async () => {
    const t = await intelHistoryAppendTest();

    const res = await t.mutation(
      internal.intelHistory.append,
      appendArgs([
        record({ dedupeKey: "a", country: "UA", category: "battle" }),
        record({
          dedupeKey: "b",
          title: "Drone strike",
          summary: "Overnight drone strike on infrastructure",
          sourceUrl: "https://example.test/1",
          occurredAt: NOW - 2 * DAY,
          embedding: unitVector(1),
        }),
      ]),
    );

    expect(res).toEqual({ inserted: 2, skipped: 0 });

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r]));
    expect(byKey.get("a")).toMatchObject({
      domain: "conflict",
      resource: "conflict-events",
      runId: "run-1",
      country: "UA",
      category: "battle",
      ingestedAt: NOW,
      occurredAt: NOW - DAY,
    });
    expect(byKey.get("a")!.embedding).toHaveLength(DIMS);
    expect(byKey.get("b")).toMatchObject({
      summary: "Overnight drone strike on infrastructure",
      sourceUrl: "https://example.test/1",
    });
  });

  test("skips a dedupeKey that already exists from an earlier run", async () => {
    const t = await intelHistoryAppendTest();

    await t.mutation(
      internal.intelHistory.append,
      appendArgs([record({ dedupeKey: "dup" })]),
    );
    const res = await t.mutation(
      internal.intelHistory.append,
      appendArgs([
        record({ dedupeKey: "dup", title: "Rewritten headline" }),
        record({ dedupeKey: "fresh" }),
      ]),
      );

    expect(res).toEqual({ inserted: 1, skipped: 1 });
    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(2);
    // The pre-existing row is untouched — append never rewrites history.
    expect(rows.find((r) => r.dedupeKey === "dup")!.title).toBe(
      "Shelling reported near Kharkiv",
    );
  });

  test("dedupes repeated keys inside a single batch", async () => {
    const t = await intelHistoryAppendTest();

    const res = await t.mutation(
      internal.intelHistory.append,
      appendArgs([record({ dedupeKey: "x" }), record({ dedupeKey: "x" })]),
    );

    expect(res).toEqual({ inserted: 1, skipped: 1 });
  });

  test("serializes simultaneous first-seen appends through the seeded lock", async () => {
    const t = await intelHistoryAppendTest();

    const results = await Promise.all([
      t.mutation(
        internal.intelHistory.append,
        appendArgs([record({ dedupeKey: "simultaneous" })], { runId: "run-a" }),
      ),
      t.mutation(
        internal.intelHistory.append,
        appendArgs([record({ dedupeKey: "simultaneous" })], { runId: "run-b" }),
      ),
    ]);

    expect(results).toContainEqual({ inserted: 1, skipped: 0 });
    expect(results).toContainEqual({ inserted: 0, skipped: 1 });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("intelHistory")
        .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", "simultaneous"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("rejects a batch larger than the append cap", async () => {
    const t = await intelHistoryAppendTest();
    const oversized = Array.from(
      { length: INTEL_HISTORY_MAX_APPEND_RECORDS + 1 },
      (_, i) => record({ dedupeKey: `k-${i}` }),
    );

    await expect(
      t.mutation(internal.intelHistory.append, appendArgs(oversized)),
    ).rejects.toThrow(/at most 100 records/i);

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(0);
  });

  test("rejects a record whose embedding is not 512-dimensional", async () => {
    const t = await intelHistoryAppendTest();

    await expect(
      t.mutation(
        internal.intelHistory.append,
        appendArgs([
          record({ dedupeKey: "ok" }),
          record({ dedupeKey: "bad", embedding: new Array(256).fill(0.1) }),
        ]),
      ),
    ).rejects.toThrow(/embedding/i);

    // Validation runs before any insert, so the whole batch is rejected.
    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(0);
  });

  test("rejects a non-finite embedding component", async () => {
    const t = await intelHistoryAppendTest();
    const poisoned = unitVector(0);
    poisoned[3] = Number.NaN;

    await expect(
      t.mutation(
        internal.intelHistory.append,
        appendArgs([record({ dedupeKey: "nan", embedding: poisoned })]),
      ),
    ).rejects.toThrow(/finite/i);
  });

  test("fails closed when the deploy-seeded append lock is absent", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.intelHistory.append, appendArgs([record()])),
    ).rejects.toThrow(/APPEND_LOCK_NOT_SEEDED/);

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(0);
  });

  test("idempotently seeds the document-backed append lock", async () => {
    const t = convexTest(schema, modules);

    expect(await t.mutation(internal.intelHistory._seedAppendLock, {})).toEqual({
      seeded: 1,
    });
    expect(await t.mutation(internal.intelHistory._seedAppendLock, {})).toEqual({
      seeded: 0,
    });
    const locks = await t.run((ctx) =>
      ctx.db.query("intelHistoryAppendLocks").collect(),
    );
    expect(locks).toHaveLength(1);
  });
});

describe("intelHistory.timeline", () => {
  test("returns the domain's events newest-first within the occurredAt range", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "old", occurredAt: NOW - 10 * DAY, title: "old" },
      { dedupeKey: "mid", occurredAt: NOW - 5 * DAY, title: "mid" },
      { dedupeKey: "new", occurredAt: NOW - DAY, title: "new" },
      {
        dedupeKey: "other-domain",
        domain: "energy",
        occurredAt: NOW - 2 * DAY,
        title: "energy",
      },
    ]);

    const res = await t.query(internal.intelHistory.timeline, {
      domain: "conflict",
      from: NOW - 6 * DAY,
      to: NOW,
    });

    expect(res.records.map((r) => r.title)).toEqual(["new", "mid"]);
  });

  test("post-filters country when the domain index is used", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "ua", country: "UA", occurredAt: NOW - DAY, title: "ua" },
      { dedupeKey: "sd", country: "SD", occurredAt: NOW - 2 * DAY, title: "sd" },
      { dedupeKey: "none", occurredAt: NOW - 3 * DAY, title: "none" },
    ]);

    const res = await t.query(internal.intelHistory.timeline, {
      domain: "conflict",
      country: "UA",
    });

    expect(res.records.map((r) => r.title)).toEqual(["ua"]);
    expect(res.partial).toBe(false);
  });

  test("marks a full post-filter candidate window as partial instead of false-empty", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "sd-1", country: "SD", occurredAt: NOW - DAY, title: "sd-1" },
      { dedupeKey: "sd-2", country: "SD", occurredAt: NOW - 2 * DAY, title: "sd-2" },
      { dedupeKey: "sd-3", country: "SD", occurredAt: NOW - 3 * DAY, title: "sd-3" },
      { dedupeKey: "sd-4", country: "SD", occurredAt: NOW - 4 * DAY, title: "sd-4" },
      { dedupeKey: "ua-after-window", country: "UA", occurredAt: NOW - 5 * DAY, title: "ua" },
    ]);

    const res = await t.query(internal.intelHistory.timeline, {
      domain: "conflict",
      country: "UA",
      limit: 1,
    });

    expect(res.records).toEqual([]);
    expect(res.partial).toBe(true);
  });

  test("serves a country-only query off the country index across domains", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "c1", country: "UA", occurredAt: NOW - DAY, title: "conflict-ua" },
      {
        dedupeKey: "e1",
        domain: "energy",
        country: "UA",
        occurredAt: NOW - 2 * DAY,
        title: "energy-ua",
      },
      { dedupeKey: "c2", country: "SD", occurredAt: NOW - 3 * DAY, title: "conflict-sd" },
    ]);

    const res = await t.query(internal.intelHistory.timeline, { country: "UA" });

    expect(res.records.map((r) => r.title)).toEqual(["conflict-ua", "energy-ua"]);
  });

  test("projects a stable id, drops the embedding, and omits absent optionals", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      {
        dedupeKey: "p1",
        occurredAt: NOW - DAY,
        title: "projected",
        summary: "a summary",
        sourceUrl: "https://example.test/p1",
        country: "UA",
        category: "battle",
      },
      { dedupeKey: "p2", occurredAt: NOW - 2 * DAY, title: "bare" },
    ]);

    const res = await t.query(internal.intelHistory.timeline, { domain: "conflict" });

    const [full, bare] = res.records;
    expect(full).toEqual({
      id: expect.any(String),
      domain: "conflict",
      resource: "conflict-events",
      country: "UA",
      category: "battle",
      title: "projected",
      summary: "a summary",
      sourceUrl: "https://example.test/p1",
      occurredAt: NOW - DAY,
      ingestedAt: NOW,
      runId: "run-seed",
      dedupeKey: "p1",
    });
    expect(full).not.toHaveProperty("embedding");
    expect(full).not.toHaveProperty("_id");
    // Absent optionals are stripped by Convex value serialization, not echoed
    // back as explicit nulls.
    expect(bare).not.toHaveProperty("country");
    expect(bare).not.toHaveProperty("summary");
  });

  test("honours an explicit limit and clamps it to the documented maximum", async () => {
    const t = convexTest(schema, modules);
    const shared = unitVector(0);
    await seed(
      t,
      Array.from({ length: TIMELINE_MAX_LIMIT + 1 }, (_, i) => ({
        dedupeKey: `bulk-${i}`,
        occurredAt: NOW - i * 1000,
        title: `bulk-${i}`,
        embedding: shared,
      })),
    );

    const two = await t.query(internal.intelHistory.timeline, {
      domain: "conflict",
      limit: 2,
    });
    expect(two.records.map((r) => r.title)).toEqual(["bulk-0", "bulk-1"]);

    const clamped = await t.query(internal.intelHistory.timeline, {
      domain: "conflict",
      limit: 10_000,
    });
    expect(clamped.records).toHaveLength(TIMELINE_MAX_LIMIT);
  });

  test("throws when neither domain nor country scopes the read", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(internal.intelHistory.timeline, { from: NOW - DAY }),
    ).rejects.toThrow(/domain.*country|country.*domain/i);
  });
});

describe("intelHistory.getByIds", () => {
  test("preserves input order, skips missing ids, and drops the embedding", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "g1", occurredAt: NOW - DAY, title: "first" },
      { dedupeKey: "g2", occurredAt: NOW - 2 * DAY, title: "second" },
    ]);

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    const first = rows.find((r) => r.dedupeKey === "g1")!;
    const second = rows.find((r) => r.dedupeKey === "g2")!;

    // Delete one row so its id is dangling when we hydrate.
    const ghostId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("intelHistory", {
        domain: "conflict",
        resource: "conflict-events",
        title: "ghost",
        occurredAt: NOW,
        ingestedAt: NOW,
        runId: "run-seed",
        dedupeKey: "ghost",
        embedding: unitVector(0),
      });
      await ctx.db.delete(id);
      return id;
    });

    const res = await t.query(internal.intelHistory.getByIds, {
      ids: [second._id, ghostId, first._id],
    });

    expect(res.map((r) => r.title)).toEqual(["second", "first"]);
    expect(res[0]).not.toHaveProperty("embedding");
    expect(res[0].id).toBe(second._id);
  });
});

describe("intelHistory.search", () => {
  test("ranks by cosine similarity and attaches _score", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "exact", title: "exact", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "near", title: "near", occurredAt: NOW - DAY, embedding: unitVector(0, 0.5) },
      { dedupeKey: "far", title: "far", occurredAt: NOW - DAY, embedding: unitVector(7) },
    ]);

    const res = await t.action(internal.intelHistory.search, {
      embedding: unitVector(0),
    });

    expect(res.records.map((r) => r.title)).toEqual(["exact", "near", "far"]);
    expect(res.records[0]._score).toBeCloseTo(1, 6);
    expect(res.records[1]._score).toBeCloseTo(1 / Math.sqrt(1.25), 6);
    expect(res.records[2]._score).toBeCloseTo(0, 6);
    expect(res.records[0]).not.toHaveProperty("embedding");
  });

  test("optionally excludes zero and negative score matches without changing the default search", async () => {
    const t = convexTest(schema, modules);
    const opposite = unitVector(0).map((component) => -component);
    await seed(t, [
      { dedupeKey: "exact", title: "exact", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "zero", title: "zero", occurredAt: NOW - DAY, embedding: unitVector(7) },
      { dedupeKey: "negative", title: "negative", occurredAt: NOW - DAY, embedding: opposite },
    ]);

    const res = await t.action(internal.intelHistory.search, {
      embedding: unitVector(0),
      limit: 3,
      minScore: 0.1,
    });

    expect(res.records.map((r) => r.title)).toEqual(["exact"]);
  });

  test("pushes the domain filter into the vector index", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "c", title: "conflict", occurredAt: NOW - DAY, embedding: unitVector(0) },
      {
        dedupeKey: "e",
        domain: "energy",
        title: "energy",
        occurredAt: NOW - DAY,
        embedding: unitVector(0),
      },
    ]);

    const res = await t.action(internal.intelHistory.search, {
      embedding: unitVector(0),
      domain: "energy",
    });

    expect(res.records.map((r) => r.title)).toEqual(["energy"]);
  });

  test("post-filters country and the occurredAt range", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      {
        dedupeKey: "hit",
        country: "UA",
        title: "hit",
        occurredAt: NOW - DAY,
        embedding: unitVector(0),
      },
      {
        dedupeKey: "wrong-country",
        country: "SD",
        title: "wrong-country",
        occurredAt: NOW - DAY,
        embedding: unitVector(0),
      },
      {
        dedupeKey: "too-old",
        country: "UA",
        title: "too-old",
        occurredAt: NOW - 90 * DAY,
        embedding: unitVector(0),
      },
    ]);

    const res = await t.action(internal.intelHistory.search, {
      embedding: unitVector(0),
      domain: "conflict",
      country: "UA",
      from: NOW - 7 * DAY,
      to: NOW,
    });

    expect(res.records.map((r) => r.title)).toEqual(["hit"]);
    expect(res.partial).toBe(false);
  });

  test("marks a full vector candidate window as partial instead of false-empty", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "sd-1", country: "SD", title: "sd-1", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "sd-2", country: "SD", title: "sd-2", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "sd-3", country: "SD", title: "sd-3", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "sd-4", country: "SD", title: "sd-4", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "ua-after-window", country: "UA", title: "ua", occurredAt: NOW - DAY, embedding: unitVector(0, 0.5) },
    ]);

    const res = await t.action(internal.intelHistory.search, {
      embedding: unitVector(0),
      domain: "conflict",
      country: "UA",
      limit: 1,
    });

    expect(res.records).toEqual([]);
    expect(res.partial).toBe(true);
  });

  test("clamps limit and rejects a wrong-dimension query vector", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "s1", title: "s1", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "s2", title: "s2", occurredAt: NOW - DAY, embedding: unitVector(0, 0.5) },
    ]);

    const limited = await t.action(internal.intelHistory.search, {
      embedding: unitVector(0),
      limit: 1,
    });
    expect(limited.records).toHaveLength(1);

    await expect(
      t.action(internal.intelHistory.search, { embedding: [0.1, 0.2] }),
    ).rejects.toThrow(/embedding/i);
  });
});

describe("intelHistory.prune", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("ages rows out by ingestedAt, so a backfill of old events survives", async () => {
    const t = convexTest(schema, modules);
    const beyond = NOW - (INTEL_HISTORY_RETENTION_DAYS + 1) * DAY;
    await seed(t, [
      { dedupeKey: "aged", ingestedAt: beyond, occurredAt: beyond, title: "aged" },
      { dedupeKey: "recent", ingestedAt: NOW - DAY, occurredAt: NOW - DAY, title: "recent" },
      // Backfilled yesterday, but the event itself predates the window. This
      // row is the whole reason retention keys on ingestedAt — pruning by
      // occurredAt would delete a backfill the night it landed.
      {
        dedupeKey: "backfilled",
        ingestedAt: NOW - DAY,
        occurredAt: beyond,
        title: "backfilled",
      },
    ]);

    const res = await t.mutation(internal.intelHistory.prune, { now: NOW });

    expect(res).toEqual({ deleted: 1, rescheduled: false });
    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(["backfilled", "recent"]);
  });

  test("self-reschedules until the backlog drains", async () => {
    const t = convexTest(schema, modules);
    const beyond = NOW - (INTEL_HISTORY_RETENTION_DAYS + 1) * DAY;
    await seed(
      t,
      Array.from({ length: 3 }, (_, i) => ({
        dedupeKey: `aged-${i}`,
        ingestedAt: beyond,
        occurredAt: beyond,
        title: `aged-${i}`,
      })),
    );

    const first = await t.mutation(internal.intelHistory.prune, {
      now: NOW,
      limit: 2,
    });
    expect(first).toEqual({ deleted: 2, rescheduled: true });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(0);
  });

  // A batch of 0 makes take(0) return [], and an unguarded `length >= batch`
  // reads 0 >= 0 as a full batch — rescheduling forever while deleting
  // nothing. The cron passes {}, but prune is operator-callable.
  test("does not reschedule itself forever when called with limit 0", async () => {
    const t = convexTest(schema, modules);
    const beyond = NOW - (INTEL_HISTORY_RETENTION_DAYS + 1) * DAY;
    await seed(t, [
      { dedupeKey: "aged-0", ingestedAt: beyond, occurredAt: beyond, title: "aged-0" },
    ]);

    const result = await t.mutation(internal.intelHistory.prune, { now: NOW, limit: 0 });

    // Floors to 1: it makes progress instead of spinning on an empty batch.
    expect(result.deleted).toBe(1);
    expect(result.rescheduled).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("POST /relay/intel-history", () => {
  let originalRelay: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    originalRelay = process.env.RELAY_SHARED_SECRET;
    process.env.RELAY_SHARED_SECRET = RELAY_SECRET;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalRelay === undefined) delete process.env.RELAY_SHARED_SECRET;
    else process.env.RELAY_SHARED_SECRET = originalRelay;
  });

  function post(body: unknown, secret: string | null = RELAY_SECRET) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret !== null) headers.Authorization = `Bearer ${secret}`;
    return { method: "POST", headers, body: JSON.stringify(body) };
  }

  function ingestBody(records: AppendRecord[]) {
    return { domain: "conflict", resource: "conflict-events", runId: "run-1", records };
  }

  test.each([
    ["missing", null],
    ["wrong", "not-the-secret"],
  ])("rejects a %s bearer secret with 401", async (_label, secret) => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(
      "/relay/intel-history",
      post(ingestBody([record()]), secret as string | null),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  test("rejects a non-object body with 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/relay/intel-history", post([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_JSON" });
  });

  test("rejects a missing runId with 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(
      "/relay/intel-history",
      post({ domain: "conflict", resource: "conflict-events", records: [record()] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("MISSING_FIELDS");
  });

  test("rejects more than 100 records with 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(
      "/relay/intel-history",
      post(
        ingestBody(
          Array.from({ length: INTEL_HISTORY_MAX_APPEND_RECORDS + 1 }, (_, i) =>
            record({ dedupeKey: `k-${i}` }),
          ),
        ),
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "TOO_MANY_RECORDS",
      max: INTEL_HISTORY_MAX_APPEND_RECORDS,
    });
  });

  test.each([
    ["short embedding", { embedding: [0.1] }],
    ["oversized title", { title: "t".repeat(501) }],
    ["oversized summary", { summary: "s".repeat(2001) }],
    ["missing dedupeKey", { dedupeKey: "" }],
    // The seeder already strips these, but this is the trust boundary: a
    // compromised relay credential must not be able to store a scheme the MCP
    // tools would publish to agents as a canonical link.
    ["javascript: sourceUrl", { sourceUrl: "javascript:alert(1)" }],
    ["data: sourceUrl", { sourceUrl: "data:text/html;base64,PHNjcmlwdD4=" }],
    ["protocol-relative sourceUrl", { sourceUrl: "//evil.test/x" }],
  ])("rejects a record with a %s (400 INVALID_RECORD)", async (_label, patch) => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(
      "/relay/intel-history",
      post(ingestBody([record(patch as Partial<AppendRecord>)])),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_RECORD");

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(0);
  });

  test("ingests records and reports the dedupe split on replay", async () => {
    const t = await intelHistoryAppendTest();
    const body = ingestBody([
      record({ dedupeKey: "h1", country: "UA" }),
      record({ dedupeKey: "h2", occurredAt: NOW - 2 * DAY }),
    ]);

    const first = await t.fetch("/relay/intel-history", post(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ inserted: 2, skipped: 0 });

    const replay = await t.fetch("/relay/intel-history", post(body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ inserted: 0, skipped: 2 });

    const rows = await t.run((ctx) => ctx.db.query("intelHistory").collect());
    expect(rows).toHaveLength(2);
  });
});

describe("internal intel read routes", () => {
  let originalConvex: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    originalConvex = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SERVER_SHARED_SECRET = CONVEX_SECRET;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalConvex === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
    else process.env.CONVEX_SERVER_SHARED_SECRET = originalConvex;
  });

  function post(body: unknown, secret: string | null = CONVEX_SECRET) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret !== null) headers["x-convex-shared-secret"] = secret;
    return { method: "POST", headers, body: JSON.stringify(body) };
  }

  test.each([
    ["/api/internal-intel-timeline", { domain: "conflict" }],
    ["/api/internal-intel-search", { embedding: [] }],
  ])("%s rejects a missing shared secret with 401", async (path, body) => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(path, post(body, null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  test.each(["/api/internal-intel-timeline", "/api/internal-intel-search"])(
    "%s rejects a wrong shared secret with 401",
    async (path) => {
      const t = convexTest(schema, modules);
      const res = await t.fetch(path, post({}, "wrong-secret"));
      expect(res.status).toBe(401);
    },
  );

  test("timeline rejects an unscoped query with 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/internal-intel-timeline", post({ from: NOW - DAY }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("MISSING_SCOPE");
  });

  test("timeline returns projected records for a scoped query", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "t1", country: "UA", occurredAt: NOW - DAY, title: "recent" },
      { dedupeKey: "t2", country: "UA", occurredAt: NOW - 30 * DAY, title: "older" },
    ]);

    const res = await t.fetch(
      "/api/internal-intel-timeline",
      post({ domain: "conflict", country: "UA", from: NOW - 7 * DAY, to: NOW }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records.map((r) => r.title)).toEqual(["recent"]);
    expect(body.records[0]).not.toHaveProperty("embedding");
  });

  test("search rejects a wrong-dimension embedding with 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(
      "/api/internal-intel-search",
      post({ embedding: [0.1, 0.2] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_EMBEDDING");
  });

  test("search returns scored records", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "v1", title: "exact", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "v2", title: "far", occurredAt: NOW - DAY, embedding: unitVector(9) },
    ]);

    const res = await t.fetch(
      "/api/internal-intel-search",
      post({ embedding: unitVector(0), domain: "conflict", limit: 5 }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ title: string; _score: number }>;
    };
    expect(body.records.map((r) => r.title)).toEqual(["exact", "far"]);
    expect(body.records[0]._score).toBeCloseTo(1, 6);
  });

  test("search forwards a valid score floor and rejects invalid values", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { dedupeKey: "v1", title: "exact", occurredAt: NOW - DAY, embedding: unitVector(0) },
      { dedupeKey: "v2", title: "far", occurredAt: NOW - DAY, embedding: unitVector(9) },
    ]);

    const filtered = await t.fetch(
      "/api/internal-intel-search",
      post({ embedding: unitVector(0), domain: "conflict", limit: 5, minScore: 0.55 }),
    );
    expect(filtered.status).toBe(200);
    expect(
      ((await filtered.json()) as { records: Array<{ title: string }> }).records.map(
        (record) => record.title,
      ),
    ).toEqual(["exact"]);

    for (const minScore of [-1.1, 1.1, Number.NaN, "0.55"]) {
      const rejected = await t.fetch(
        "/api/internal-intel-search",
        post({ embedding: unitVector(0), domain: "conflict", minScore }),
      );
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error).toBe("INVALID_MIN_SCORE");
    }
  });
});
