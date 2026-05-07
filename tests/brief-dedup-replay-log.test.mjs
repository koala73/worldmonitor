/**
 * Unit tests for the replayable per-story input log.
 *
 * Covers:
 *   1. Flag OFF → no writes, returns skipped=disabled (default behaviour)
 *   2. Flag ON + empty stories → no writes
 *   3. Flag ON + stories → RPUSH with one record per story + EXPIRE 30d
 *   4. Record fields match §5 Phase 1 spec (hash, originalIndex, isRep,
 *      clusterId, title/normalizedTitle, link, severity/score/mentions,
 *      phase/sources, embeddingCacheKey, hasEmbedding, tickConfig)
 *   5. clusterId derived correctly from rep.mergedHashes (Jaccard + embed
 *      output shapes both populate mergedHashes — one codepath)
 *   6. isRep only set for the materialized winning hash of each cluster
 *   7. Pipeline returns null (creds missing) → warn + skipped
 *   8. Pipeline throws → caught, warn emitted, no exception propagates
 *   9. Key shape: digest:replay-log:v1:{safeRuleId}:{YYYY-MM-DD}
 *  10. Only DIGEST_DEDUP_REPLAY_LOG='1' literal enables (case-sensitive,
 *      no 'yes'/'true'/'True' lenience — fail-closed typo-safety)
 *
 * Run: node --test tests/brief-dedup-replay-log.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReplayLogKey,
  buildReplayRecords,
  replayLogEnabled,
  writeReplayLog,
} from '../scripts/lib/brief-dedup-replay-log.mjs';
import { cacheKeyFor, normalizeForEmbedding } from '../scripts/lib/brief-embedding.mjs';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function story(title, { hash, score = 10, mentions = 1, severity = 'high', link = '', phase = 'emerging', sources = [] } = {}) {
  return {
    hash: hash ?? `h-${title.slice(0, 16).replace(/\W+/g, '-')}`,
    title,
    link,
    severity,
    currentScore: score,
    mentionCount: mentions,
    phase,
    sources,
  };
}

function rep(hash, mergedHashes, extras = {}) {
  return { hash, mergedHashes, ...extras };
}

function mockPipeline() {
  const calls = [];
  const impl = async (commands) => {
    calls.push(commands);
    return commands.map(() => ({ result: 'OK' }));
  };
  return { impl, calls };
}

function mockWarn() {
  const lines = [];
  return { impl: (line) => lines.push(line), lines };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('replayLogEnabled — env parsing', () => {
  it('OFF by default (unset)', () => {
    assert.equal(replayLogEnabled({}), false);
  });

  it('OFF on "0", "yes", "true", "True", "1 " (trailing space), empty', () => {
    for (const v of ['0', 'yes', 'true', 'True', '1 ', '']) {
      assert.equal(
        replayLogEnabled({ DIGEST_DEDUP_REPLAY_LOG: v }),
        false,
        `expected OFF for ${JSON.stringify(v)}`,
      );
    }
  });

  it('ON only for literal "1"', () => {
    assert.equal(replayLogEnabled({ DIGEST_DEDUP_REPLAY_LOG: '1' }), true);
  });
});

describe('buildReplayLogKey — key shape', () => {
  it('produces digest:replay-log:v1:{ruleId}:{YYYY-MM-DD} on sample input', () => {
    const ts = Date.UTC(2026, 3, 23, 8, 2, 0); // 2026-04-23T08:02:00Z
    const key = buildReplayLogKey('full:en:high', ts);
    assert.equal(key, 'digest:replay-log:v1:full:en:high:2026-04-23');
  });

  it('sanitises ruleId to [A-Za-z0-9:_-] (keeps colons for composite ids)', () => {
    const ts = Date.UTC(2026, 3, 23);
    const key = buildReplayLogKey('full/en::weird chars!', ts);
    assert.equal(key, 'digest:replay-log:v1:full_en::weird_chars_:2026-04-23');
  });

  it('falls back to ruleId="unknown" on null/empty', () => {
    const ts = Date.UTC(2026, 3, 23);
    assert.equal(
      buildReplayLogKey(null, ts),
      'digest:replay-log:v1:unknown:2026-04-23',
    );
    // A string of only unsafe chars → sanitised to empty → "unknown"
    assert.equal(
      buildReplayLogKey('!!!!', ts),
      'digest:replay-log:v1:unknown:2026-04-23',
    );
  });

  it('falls back to ruleId="unknown" on pathological separator-only inputs', () => {
    // Regression guard (Greptile P2): a ruleId of pure separators
    // (':', '-', '_' or mixtures) has no identifying content — passing
    // it through verbatim would produce keys like
    // `digest:replay-log:v1::::2026-04-23` that confuse redis-cli
    // namespace tooling. The emptiness check strips ':' / '-' / '_'
    // before deciding to fall back.
    const ts = Date.UTC(2026, 3, 23);
    for (const raw of [':::', '---', '___', ':_:', '-_-', '::-:--']) {
      assert.equal(
        buildReplayLogKey(raw, ts),
        'digest:replay-log:v1:unknown:2026-04-23',
        `ruleId=${JSON.stringify(raw)} should fall back to "unknown"`,
      );
    }
  });
});

describe('buildReplayRecords — record shape', () => {
  const s1 = story('Nigeria coup trial opens, six charged', { hash: 'h1' });
  const s2 = story('Alleged Coup: one defendant arrives', { hash: 'h2' });
  const s3 = story('Russia halts Druzhba oil to Germany', { hash: 'h3' });
  const stories = [s1, s2, s3];
  // Pretend dedup merged s1+s2 into cluster-0 (rep=s1), s3 alone in cluster-1.
  const reps = [
    rep('h1', ['h1', 'h2'], { currentScore: 10 }),
    rep('h3', ['h3'], { currentScore: 8 }),
  ];
  const cfg = {
    mode: 'embed',
    clustering: 'single',
    cosineThreshold: 0.6,
    topicGroupingEnabled: true,
    topicThreshold: 0.45,
    entityVetoEnabled: true,
  };
  const tickContext = { briefTickId: 'tick-1', ruleId: 'full:en:high', tsMs: 1000 };

  it('produces one record per input story', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    assert.equal(records.length, 3);
  });

  it('preserves originalIndex in input order', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    assert.deepEqual(records.map((r) => r.originalIndex), [0, 1, 2]);
  });

  it('isRep is true exactly for each cluster rep hash', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    const byHash = new Map(records.map((r) => [r.storyHash, r]));
    assert.equal(byHash.get('h1').isRep, true);
    assert.equal(byHash.get('h2').isRep, false);
    assert.equal(byHash.get('h3').isRep, true);
  });

  // Codex PR #3617 P1 — Sprint 1 / U6 v2 shape: every record carries
  // `repHash` (canonical stable cluster identity), reps additionally
  // carry `mergedHashes`, and `headline`/`sourceUrl` aliases for the
  // U5 classifier shape.
  it('repHash is the rep\'s own hash, set on EVERY record (rep AND non-rep) — Codex PR #3617 P1', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    const byHash = new Map(records.map((r) => [r.storyHash, r]));
    assert.equal(byHash.get('h1').repHash, 'h1', 'rep h1 → repHash=h1');
    assert.equal(byHash.get('h2').repHash, 'h1', 'non-rep h2 in cluster {h1,h2} → repHash=h1');
    assert.equal(byHash.get('h3').repHash, 'h3', 'singleton h3 → repHash=h3');
  });

  it('mergedHashes is set on rep records, null on non-rep records', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    const byHash = new Map(records.map((r) => [r.storyHash, r]));
    assert.deepEqual(byHash.get('h1').mergedHashes, ['h1', 'h2']);
    assert.equal(byHash.get('h2').mergedHashes, null, 'non-rep gets null mergedHashes');
    assert.deepEqual(byHash.get('h3').mergedHashes, ['h3']);
  });

  it('headline aliases title; sourceUrl aliases link (U5 classifier-shape compat)', () => {
    const sWithLink = { ...s1, link: 'https://example.com/n1' };
    const repsWithLink = [rep('h1', ['h1'], { currentScore: 10 })];
    const records = buildReplayRecords([sWithLink], repsWithLink, new Map(), cfg, tickContext);
    assert.equal(records[0].headline, sWithLink.title);
    assert.equal(records[0].sourceUrl, 'https://example.com/n1');
    // Legacy fields preserved for back-compat.
    assert.equal(records[0].title, sWithLink.title);
    assert.equal(records[0].link, 'https://example.com/n1');
  });

  it('writer emits v=2 (Codex PR #3617 P1 bump)', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    for (const r of records) assert.equal(r.v, 2, `record v should be 2; got ${r.v}`);
  });

  // Codex PR #3617 round-3 P1 — sources come from the REP's hydrated
  // set, not from individual input stories. Pre-fix mutating
  // dedupedAll[i].sources didn't reach the writer because it iterated
  // input `stories` (which materializeCluster() never wrote back to).
  it('sources are sourced from the rep object (not input story.sources)', () => {
    // Rep with hydrated sources, input story with EMPTY sources.
    // Pre-fix the writer would have emitted sources: [] (reading from
    // the input story). Post-fix it reads from the rep.
    const repWithSources = rep('h1', ['h1', 'h2'], { currentScore: 10, sources: ['Reuters', 'AP', 'BBC'] });
    const recs = buildReplayRecords(
      [story('a', { hash: 'h1', sources: [] }), story('b', { hash: 'h2', sources: [] })],
      [repWithSources],
      new Map(),
      cfg,
      tickContext,
    );
    const byHash = new Map(recs.map((r) => [r.storyHash, r]));
    assert.deepEqual(byHash.get('h1').sources, ['Reuters', 'AP', 'BBC']);
    // Non-rep gets the SAME hydrated sources (cluster source-count
    // identity is uniform across members — the rep is the canonical view).
    assert.deepEqual(byHash.get('h2').sources, ['Reuters', 'AP', 'BBC']);
  });

  it('falls back to story.sources when rep has none (defensive — fixture compatibility)', () => {
    // Some test fixtures pass pre-populated input story.sources and
    // omit them on the rep. The writer should still emit those rather
    // than dropping them silently.
    const repNoSources = { hash: 'h1', mergedHashes: ['h1'], currentScore: 5, mentionCount: 1 };
    const recs = buildReplayRecords(
      [story('a', { hash: 'h1', sources: ['fixture-source'] })],
      [repNoSources],
      new Map(),
      cfg,
      tickContext,
    );
    assert.deepEqual(recs[0].sources, ['fixture-source']);
  });

  it('clusterId derives from rep.mergedHashes (s1+s2 → 0, s3 → 1)', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    const byHash = new Map(records.map((r) => [r.storyHash, r]));
    assert.equal(byHash.get('h1').clusterId, 0);
    assert.equal(byHash.get('h2').clusterId, 0);
    assert.equal(byHash.get('h3').clusterId, 1);
  });

  it('embeddingCacheKey matches cacheKeyFor(normalizeForEmbedding(title))', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    assert.equal(
      records[0].embeddingCacheKey,
      cacheKeyFor(normalizeForEmbedding(s1.title)),
    );
  });

  it('hasEmbedding reflects sidecar membership', () => {
    const vec = new Array(512).fill(0.1);
    const sidecar = new Map([['h1', vec]]);
    const records = buildReplayRecords(stories, reps, sidecar, cfg, tickContext);
    const byHash = new Map(records.map((r) => [r.storyHash, r]));
    assert.equal(byHash.get('h1').hasEmbedding, true);
    assert.equal(byHash.get('h2').hasEmbedding, false);
    assert.equal(byHash.get('h3').hasEmbedding, false);
  });

  it('tickConfig snapshot mirrors cfg (all behaviour-defining fields)', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    assert.deepEqual(records[0].tickConfig, {
      mode: 'embed',
      clustering: 'single',
      cosineThreshold: 0.6,
      topicGroupingEnabled: true,
      topicThreshold: 0.45,
      entityVetoEnabled: true,
    });
  });

  it('tickConfig is a per-record shallow copy (not a shared reference)', () => {
    // Regression guard (Greptile P2): mutating one record's tickConfig
    // must not affect other records in the same batch. A shared-ref
    // implementation had no storage bug (JSON.stringify serialises
    // each record independently) but would bite any in-memory
    // consumer that mutates for experimentation.
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    assert.ok(records.length >= 2);
    assert.notStrictEqual(
      records[0].tickConfig,
      records[1].tickConfig,
      'records must not share tickConfig by reference',
    );
    records[0].tickConfig.mode = 'MUTATED';
    assert.equal(records[1].tickConfig.mode, 'embed', 'mutation must not leak');
  });

  it('serialises topicGroupingEnabled=false distinctly from default', () => {
    // Regression guard: a tick run with DIGEST_DEDUP_TOPIC_GROUPING=0
    // must be replay-distinguishable from a normal tick. Prior to this
    // field being captured, both serialised to the same tickConfig and
    // downstream replays could not reconstruct the output ordering.
    const cfgOff = { ...cfg, topicGroupingEnabled: false };
    const records = buildReplayRecords(stories, reps, new Map(), cfgOff, tickContext);
    assert.equal(records[0].tickConfig.topicGroupingEnabled, false);
    // And the default-on tick serialises true, not identical:
    const recordsOn = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    assert.notDeepEqual(recordsOn[0].tickConfig, records[0].tickConfig);
  });

  it('tickContext fields copied onto every record', () => {
    const records = buildReplayRecords(stories, reps, new Map(), cfg, tickContext);
    for (const r of records) {
      assert.equal(r.briefTickId, 'tick-1');
      assert.equal(r.ruleId, 'full:en:high');
      assert.equal(r.tsMs, 1000);
      // Codex PR #3617 P1 — bumped to v2 (added repHash + mergedHashes
      // + headline + sourceUrl). v1 envelopes still in 30d TTL are
      // accepted on read by the U6 harness via legacy-field fallbacks.
      assert.equal(r.v, 2);
    }
  });

  it('handles rep without mergedHashes (falls back to rep.hash alone)', () => {
    const repsNoMerged = [{ hash: 'h1' }, { hash: 'h3' }];
    const records = buildReplayRecords(
      [story('a', { hash: 'h1' }), story('b', { hash: 'h3' })],
      repsNoMerged,
      new Map(),
      cfg,
      tickContext,
    );
    assert.equal(records[0].clusterId, 0);
    assert.equal(records[1].clusterId, 1);
    assert.equal(records[0].isRep, true);
    assert.equal(records[1].isRep, true);
  });
});

describe('writeReplayLog — behaviour', () => {
  const baseArgs = () => {
    const s1 = story('Nigeria coup trial opens', { hash: 'h1', link: 'https://example.com/nigeria-coup' });
    const s2 = story('Alleged Coup: defendant arrives', { hash: 'h2' });
    return {
      stories: [s1, s2],
      reps: [rep('h1', ['h1', 'h2'])],
      embeddingByHash: new Map(),
      cfg: {
        mode: 'embed',
        clustering: 'single',
        cosineThreshold: 0.6,
        topicThreshold: 0.45,
        entityVetoEnabled: true,
      },
      tickContext: {
        briefTickId: 'tick-1',
        ruleId: 'full:en:high',
        tsMs: Date.UTC(2026, 3, 23, 8, 2, 0),
      },
    };
  };

  it('flag OFF → skipped=disabled, no pipeline call, no warn', async () => {
    const pipe = mockPipeline();
    const warn = mockWarn();
    const res = await writeReplayLog({
      ...baseArgs(),
      deps: { env: {}, redisPipeline: pipe.impl, warn: warn.impl },
    });
    assert.deepEqual(res, { wrote: 0, key: null, skipped: 'disabled' });
    assert.equal(pipe.calls.length, 0);
    assert.equal(warn.lines.length, 0);
  });

  it('flag ON + empty stories → skipped=empty, no pipeline call', async () => {
    const pipe = mockPipeline();
    const warn = mockWarn();
    const res = await writeReplayLog({
      ...baseArgs(),
      stories: [],
      deps: { env: { DIGEST_DEDUP_REPLAY_LOG: '1' }, redisPipeline: pipe.impl, warn: warn.impl },
    });
    assert.equal(res.skipped, 'empty');
    assert.equal(pipe.calls.length, 0);
  });

  it('flag ON + stories → RPUSH + EXPIRE 30d on correct key', async () => {
    const pipe = mockPipeline();
    const warn = mockWarn();
    const res = await writeReplayLog({
      ...baseArgs(),
      deps: { env: { DIGEST_DEDUP_REPLAY_LOG: '1' }, redisPipeline: pipe.impl, warn: warn.impl },
    });
    assert.equal(res.wrote, 2);
    assert.equal(res.key, 'digest:replay-log:v1:full:en:high:2026-04-23');
    assert.equal(res.skipped, null);
    assert.equal(pipe.calls.length, 1);
    const [commands] = pipe.calls;
    assert.equal(commands.length, 2, 'two commands: RPUSH + EXPIRE');
    const [rpushCmd, expireCmd] = commands;
    assert.equal(rpushCmd[0], 'RPUSH');
    assert.equal(rpushCmd[1], 'digest:replay-log:v1:full:en:high:2026-04-23');
    assert.equal(rpushCmd.length, 4, 'RPUSH + key + 2 story records');
    assert.equal(expireCmd[0], 'EXPIRE');
    assert.equal(expireCmd[1], 'digest:replay-log:v1:full:en:high:2026-04-23');
    assert.equal(expireCmd[2], String(30 * 24 * 60 * 60));
    // Each pushed value is a JSON-stringified record.
    const rec0 = JSON.parse(rpushCmd[2]);
    const rec1 = JSON.parse(rpushCmd[3]);
    assert.equal(rec0.storyHash, 'h1');
    assert.equal(rec0.isRep, true);
    assert.equal(rec0.link, 'https://example.com/nigeria-coup');
    assert.equal(rec1.storyHash, 'h2');
    assert.equal(rec1.isRep, false);
    assert.equal(rec1.clusterId, 0, 'h2 is in the same cluster as h1');
    assert.equal(warn.lines.length, 0);
  });

  it('pipeline returns null → warn + skipped=null + wrote=0', async () => {
    const warn = mockWarn();
    const res = await writeReplayLog({
      ...baseArgs(),
      deps: {
        env: { DIGEST_DEDUP_REPLAY_LOG: '1' },
        redisPipeline: async () => null,
        warn: warn.impl,
      },
    });
    assert.equal(res.wrote, 0);
    assert.notEqual(res.key, null, 'key is reported even on null pipeline (diagnostic)');
    assert.equal(warn.lines.length, 1);
    assert.match(warn.lines[0], /replay-log.*pipeline returned null/);
  });

  it('pipeline throws → caught, warn emitted, never re-throws', async () => {
    const warn = mockWarn();
    const res = await writeReplayLog({
      ...baseArgs(),
      deps: {
        env: { DIGEST_DEDUP_REPLAY_LOG: '1' },
        redisPipeline: async () => { throw new Error('upstash exploded'); },
        warn: warn.impl,
      },
    });
    assert.equal(res.wrote, 0);
    assert.equal(warn.lines.length, 1);
    assert.match(warn.lines[0], /replay-log.*write failed.*upstash exploded/);
  });

  it('malformed args → no throw, returns a result object', async () => {
    const warn = mockWarn();
    // No stories at all — should skip cleanly.
    const res = await writeReplayLog({
      deps: { env: { DIGEST_DEDUP_REPLAY_LOG: '1' }, warn: warn.impl },
    });
    assert.equal(res.skipped, 'empty');
  });
});
