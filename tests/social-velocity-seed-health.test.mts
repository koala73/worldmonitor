// Runtime proof of the social-velocity seed-meta contract in scripts/ais-relay.cjs
// (#8690, replacing the source-text checks in social-velocity-seed-health.test.mjs).
//
// The relay is a long-running process that starts servers on import, so the
// social-velocity region is evaluated in a vm context with its I/O injected,
// the same harness tests/social-velocity-boundary.test.mts uses. What is
// pinned is the OBSERVABLE contract health depends on: the canonical key is
// written before healthy meta, healthy meta is never written when the
// canonical write fails, and every failure path leaves an `error` meta with a
// reason instead of silently extending the previous one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const CANONICAL_KEY = 'intelligence:social:reddit:v1';
const META_KEY = 'seed-meta:intelligence:social-reddit';
const RETRY_MS = 20 * 60 * 1000;

const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const region = source.slice(
  source.indexOf('const SOCIAL_VELOCITY_REDIS_KEY ='),
  source.indexOf('async function startSocialVelocitySeedLoop()'),
);
assert.ok(region.length > 0, 'social-velocity region markers must exist in scripts/ais-relay.cjs');

type Listing = { ok: boolean; status?: number; source?: string; posts?: unknown[] };
type Options = {
  listing?: (subreddit: string) => Promise<Listing>;
  envelopeWrite?: () => Promise<boolean>;
  upstashSet?: () => Promise<boolean>;
};

const goodPost = { id: 'abc123', title: 'A report', permalink: '/r/worldnews/comments/abc123/a_report/', score: 10, upvote_ratio: 0.9, num_comments: 2, created_utc: Date.now() / 1000 - 60 };

function harness(options: Options = {}) {
  const calls: Array<{ op: string; key: string; value?: unknown; ttl?: number }> = [];
  const timers: number[] = [];
  const seed = runInNewContext(`${region}\nseedSocialVelocity`, {
    URL, Date, console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn: () => void, ms: number) => { if (ms === 500) fn(); else timers.push(ms); return 1; },
    clearTimeout() {},
    fetchRedditHotListing: options.listing ?? (async () => ({ ok: true, posts: [goodPost] })),
    envelopeWrite: async (key: string, value: unknown, ttl: number) => {
      calls.push({ op: 'envelopeWrite', key, value, ttl });
      return options.envelopeWrite ? options.envelopeWrite() : true;
    },
    upstashSet: async (key: string, value: unknown, ttl: number) => {
      calls.push({ op: 'upstashSet', key, value, ttl });
      return options.upstashSet ? options.upstashSet() : true;
    },
    upstashExpire: async (key: string, ttl: number) => { calls.push({ op: 'upstashExpire', key, ttl }); return true; },
  }) as () => Promise<void>;
  const metaWrites = () => calls.filter((c) => c.op === 'upstashSet' && c.key === META_KEY).map((c) => c.value as Record<string, unknown>);
  return { seed, calls, timers, metaWrites };
}

describe('social velocity seed-meta contract', () => {
  it('writes the canonical key first and healthy meta only afterwards', async () => {
    const h = harness();
    await h.seed();
    assert.deepEqual(h.calls.map((c) => c.op), ['envelopeWrite', 'upstashSet']);
    assert.equal(h.calls[0].key, CANONICAL_KEY);
    const [meta] = h.metaWrites();
    assert.equal(meta.status, 'ok');
    assert.equal(meta.recordCount, 2, 'one accepted post per subreddit');
    assert.equal(meta.sourceVersion, 'social-reddit');
    assert.equal(typeof meta.fetchedAt, 'number');
    assert.equal(h.calls[1].ttl, 604800);
    assert.deepEqual(h.timers, [], 'a successful run schedules no retry');
  });

  it('marks seed-meta as error and never writes healthy meta when the canonical write fails', async () => {
    const h = harness({ envelopeWrite: async () => false });
    await h.seed();
    const metas = h.metaWrites();
    assert.equal(metas.length, 1);
    assert.equal(metas[0].status, 'error');
    assert.equal(metas[0].recordCount, 0);
    assert.equal(metas[0].errorReason, 'canonical_write_failed');
    assert.ok(!metas.some((m) => m.status === 'ok'), 'healthy meta must not advance past a failed canonical write');
  });

  it('records each Reddit failure in the error reason, extends the last-good TTL and schedules a retry', async () => {
    const h = harness({ listing: async (subreddit) => ({ ok: false, status: subreddit === 'worldnews' ? 429 : 503, source: 'direct', posts: [] }) });
    await h.seed();
    assert.ok(!h.calls.some((c) => c.op === 'envelopeWrite'), 'no posts means no canonical write');
    assert.deepEqual(h.calls.filter((c) => c.op === 'upstashExpire'), [{ op: 'upstashExpire', key: CANONICAL_KEY, ttl: 43200 }]);
    const [meta] = h.metaWrites();
    assert.equal(meta.status, 'error');
    assert.equal(meta.errorReason, 'empty_reddit_response: r/worldnews HTTP 429 (direct); r/geopolitics HTTP 503 (direct)');
    assert.deepEqual(h.timers, [RETRY_MS]);
  });

  it('reports an empty but successful listing distinctly from a fetch failure', async () => {
    const h = harness({ listing: async () => ({ ok: true, posts: [] }) });
    await h.seed();
    assert.equal(h.metaWrites()[0].errorReason, 'empty_reddit_response');
  });

  it('turns a thrown seed error into an error meta with the message, TTL extension and retry', async () => {
    const h = harness({ listing: async () => { throw new Error('socket hang up'); } });
    await h.seed();
    const [meta] = h.metaWrites();
    assert.equal(meta.status, 'error');
    assert.equal(meta.errorReason, 'seed_error: socket hang up');
    assert.ok(h.calls.some((c) => c.op === 'upstashExpire' && c.key === CANONICAL_KEY));
    assert.deepEqual(h.timers, [RETRY_MS]);
  });

  it('bounds and flattens the error reason', async () => {
    const h = harness({ listing: async () => { throw new Error(`multi\n\nline ${'x'.repeat(400)}`); } });
    await h.seed();
    const reason = String(h.metaWrites()[0].errorReason);
    assert.equal(reason.length, 240);
    assert.ok(!/\s{2,}/.test(reason));
  });

  it('survives a healthy meta write that throws, keeping the canonical payload', async () => {
    const h = harness({ upstashSet: async () => { throw new Error('redis down'); } });
    await h.seed();
    assert.equal(h.calls.filter((c) => c.op === 'envelopeWrite').length, 1);
    assert.deepEqual(h.timers, [], 'a meta write failure after a good canonical write is not a seed failure');
  });
});
