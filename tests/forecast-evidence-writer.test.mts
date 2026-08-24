import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FORECAST_EVIDENCE_MAX_LOOKBACK_MS } from '../scripts/_forecast-evidence-archive.mjs';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const nowMs = 1_750_000_000_000;
const coverage = {
  v: 1,
  coverageStartMs: nowMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  coverageEndMs: nowMs,
  cutoverVerifiedAtMs: nowMs - 1,
  sourceDigestAtMs: nowMs,
  maxLookbackMs: FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  retentionSeconds: 15 * 24 * 60 * 60,
  sourceKey: 'digest:accumulator:v1:full:en',
  legacyOldestHash: 'f'.repeat(64),
  legacyOldestScoreMs: nowMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS - 1,
};

describe('forecast evidence writer cutover gate (#7082)', () => {
  it('distinguishes a confirmed Redis pipeline from an empty/error result', () => {
    assert.equal(__testing__.redisPipelineConfirmed([{ result: 'OK' }], 1), true);
    assert.equal(__testing__.redisPipelineConfirmed([], 1), false);
    assert.equal(__testing__.redisPipelineConfirmed([{ error: 'timeout' }], 1), false);
  });

  it('does not prune when coverage read or an earlier write was unconfirmed', () => {
    const complete = {
      evidenceEligible: true,
      cutoverEnabled: true,
      coverage,
      nowMs,
      trackingWritesConfirmed: true,
      evidenceWritesConfirmed: true,
      coverageAdvanced: true,
      accumulatorTtlConfirmed: true,
    };
    assert.equal(__testing__.shouldPruneAccumulator(complete), true);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, cutoverEnabled: false }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, coverage: null }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, evidenceWritesConfirmed: false }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, trackingWritesConfirmed: false }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, accumulatorTtlConfirmed: false }), false);
  });

  it('requires the cutover marker to cover the full 14-day declared window', () => {
    assert.equal(__testing__.shouldPruneAccumulator({
      evidenceEligible: true,
      cutoverEnabled: true,
      coverage: { ...coverage, coverageStartMs: coverage.coverageStartMs + 1 },
      nowMs,
      trackingWritesConfirmed: true,
      evidenceWritesConfirmed: true,
      coverageAdvanced: true,
      accumulatorTtlConfirmed: true,
    }), false);
  });

  it('preserves confirmed pruning for scopes outside full/en', () => {
    assert.equal(__testing__.shouldPruneAccumulator({
      evidenceEligible: false,
      cutoverEnabled: false,
      coverage: null,
      nowMs,
      trackingWritesConfirmed: true,
      evidenceWritesConfirmed: false,
      coverageAdvanced: false,
      accumulatorTtlConfirmed: true,
    }), true);
  });
});

// ---------------------------------------------------------------------------
// Wiring tests. The gate helpers above are pure and were the ONLY thing this
// suite covered, so the orchestration around them — which pipeline carries
// which commands, whether the marker TTL is refreshed, whether a preview
// deployment writes production keys — shipped untested. These drive the real
// writeStoryTracking through a fake Upstash REST endpoint, so every assertion
// is about a command that actually reached the wire.
// ---------------------------------------------------------------------------

type RedisCall = { url: string; body: unknown };

function fakeUpstash(options: { coverage?: unknown; failEvidence?: boolean } = {}) {
  const calls: RedisCall[] = [];
  const fetchImpl = async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    // readCachedJson issues GET /get/<key>; pipelines POST a command array.
    if (url.includes('/get/')) {
      calls.push({ url, body: null });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: options.coverage === undefined ? null : JSON.stringify(options.coverage),
        }),
      };
    }
    const body = JSON.parse(init?.body ?? '[]');
    calls.push({ url, body });
    const commands: unknown[][] = Array.isArray(body) ? body : [];
    const touchesEvidence = commands.some(
      (command) => typeof command?.[1] === 'string' && String(command[1]).startsWith('forecast:evidence'),
    );
    if (options.failEvidence && touchesEvidence) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => commands.map(() => ({ result: 'OK' })) };
  };
  const commandsOf = (predicate: (verb: string, key: string) => boolean) =>
    calls
      .flatMap(({ body }) => (Array.isArray(body) ? (body as unknown[][]) : []))
      .filter((command) => predicate(String(command?.[0]), String(command?.[1])));
  return { calls, fetchImpl, commandsOf };
}

function storyItem(overrides: Record<string, unknown> = {}) {
  return {
    source: 'Example Wire',
    originPublisher: 'Example Wire',
    title: 'Central bank holds rates',
    link: 'https://news.example/rates',
    publishedAt: nowMs - 60_000,
    isAlert: false,
    level: 'low',
    category: 'markets',
    confidence: 1,
    classSource: 'keyword',
    importanceScore: 10,
    credibilityScore: 10,
    corroborationCount: 1,
    entityCorroborationCount: 1,
    lang: 'en',
    description: 'Officials held rates unchanged.',
    isOpinion: false,
    isFeelGood: false,
    ...overrides,
  };
}

async function runWriter(config: {
  variant?: string;
  lang?: string;
  vercelEnv?: string;
  cutover?: boolean;
  coverage?: unknown;
  items?: Array<Record<string, unknown>>;
  failEvidence?: boolean;
} = {}) {
  const {
    variant = 'full', lang = 'en', vercelEnv = 'production',
    cutover = false, coverage: marker, items = [storyItem()], failEvidence = false,
  } = config;
  const redis = fakeUpstash({ coverage: marker, failEvidence });
  const saved = {
    fetch: globalThis.fetch,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vercelEnv: process.env.VERCEL_ENV,
    cutover: process.env.FORECAST_EVIDENCE_CUTOVER_ENABLED,
    localMode: process.env.LOCAL_API_MODE,
  };
  globalThis.fetch = redis.fetchImpl as unknown as typeof fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.VERCEL_ENV = vercelEnv;
  delete process.env.LOCAL_API_MODE;
  if (cutover) process.env.FORECAST_EVIDENCE_CUTOVER_ENABLED = '1';
  else delete process.env.FORECAST_EVIDENCE_CUTOVER_ENABLED;
  try {
    const hashes = items.map((_, index) => String(index + 1).repeat(64).slice(0, 64));
    items.forEach((item, index) => { item.titleHash = hashes[index]; });
    await __testing__.writeStoryTracking(items as never, variant, lang, hashes);
  } finally {
    globalThis.fetch = saved.fetch;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('UPSTASH_REDIS_REST_URL', saved.url);
    restore('UPSTASH_REDIS_REST_TOKEN', saved.token);
    restore('VERCEL_ENV', saved.vercelEnv);
    restore('FORECAST_EVIDENCE_CUTOVER_ENABLED', saved.cutover);
    restore('LOCAL_API_MODE', saved.localMode);
  }
  return redis;
}

describe('forecast evidence publication wiring (#7082)', () => {
  it('publishes a self-contained record and a stable index member per story', async () => {
    const redis = await runWriter({ coverage });
    const sets = redis.commandsOf((verb, key) => verb === 'SET' && key.startsWith('forecast:evidence:record:v1:'));
    const zadds = redis.commandsOf((verb, key) => verb === 'ZADD' && key === 'forecast:evidence:v1');
    assert.equal(sets.length, 1);
    assert.equal(zadds.length, 1);
    // The record carries its own payload — no story:track dependency, which is
    // the whole point of the archive (those rows expire at 7 days).
    const payload = JSON.parse(String(sets[0][2]));
    assert.equal(payload.title, 'Central bank holds rates');
    assert.equal(payload.link, 'https://news.example/rates');
  });

  it('writes NOTHING to the archive from a preview deployment', async () => {
    // Archive keys are written raw, bypassing getKeyPrefix(), and previews
    // share the production Upstash instance — so an unguarded preview build
    // would rewrite the marker that authorises destructive pruning.
    const redis = await runWriter({ vercelEnv: 'preview', coverage });
    assert.deepEqual(redis.commandsOf((_verb, key) => key.startsWith('forecast:evidence')), []);
    assert.equal(redis.calls.some(({ url }) => url.includes('forecast')), false);
    // The accumulator write still happens: it is prefixed, so it is isolated.
    assert.equal(redis.commandsOf((verb, key) => verb === 'ZADD' && key.includes('digest:accumulator')).length, 1);
  });

  it('archives nothing for a non-full/en scope', async () => {
    const redis = await runWriter({ variant: 'finance', coverage });
    assert.deepEqual(redis.commandsOf((_verb, key) => key.startsWith('forecast:evidence')), []);
  });

  it('refreshes the marker TTL even when this cycle cannot advance coverage', async () => {
    // A story that cannot build a member blocks the advance. If that also
    // skipped the SET, the marker's 15-day EX would eventually lapse and
    // recovery would need another backfill run.
    const redis = await runWriter({
      coverage,
      items: [storyItem(), storyItem({ link: '', title: 'Unbuildable' })],
    });
    const markerSets = redis.commandsOf((verb, key) => verb === 'SET' && key === 'forecast:evidence:coverage:v1');
    assert.equal(markerSets.length, 1, 'the marker is re-SET to refresh its TTL');
    assert.equal(markerSets[0][3], 'EX');
    const written = JSON.parse(String(markerSets[0][2]));
    assert.equal(written.coverageEndMs, coverage.coverageEndMs, 'the window did not move: a story was dropped');
  });

  it('advances the coverage window on a clean cycle', async () => {
    const redis = await runWriter({ coverage });
    const markerSets = redis.commandsOf((verb, key) => verb === 'SET' && key === 'forecast:evidence:coverage:v1');
    assert.equal(markerSets.length, 1);
    const written = JSON.parse(String(markerSets[0][2]));
    assert.ok(written.coverageEndMs > coverage.coverageEndMs);
    assert.equal(written.sourceDigestAtMs, written.coverageEndMs, 'the parser invariant is preserved');
  });

  it('does not prune the judged accumulator before the cutover flag is set', async () => {
    const redis = await runWriter({ coverage });
    assert.deepEqual(
      redis.commandsOf((verb, key) => verb === 'ZREMRANGEBYSCORE' && key.includes('digest:accumulator')),
      [],
    );
  });

  it('prunes the judged accumulator once cutover is enabled and the cycle is clean', async () => {
    const redis = await runWriter({ coverage, cutover: true });
    const prunes = redis.commandsOf((verb, key) => verb === 'ZREMRANGEBYSCORE' && key.includes('digest:accumulator'));
    assert.equal(prunes.length, 1);
    assert.equal(prunes[0][2], '-inf');
  });

  it('does not prune the judged accumulator when the archive write failed', async () => {
    const redis = await runWriter({ coverage, cutover: true, failEvidence: true });
    assert.deepEqual(
      redis.commandsOf((verb, key) => verb === 'ZREMRANGEBYSCORE' && key.includes('digest:accumulator')),
      [],
      'an unconfirmed archive write must never authorise destroying the legacy copy',
    );
  });

  it('prunes a non-judged accumulator without needing the cutover flag', async () => {
    // Judging never reads these scopes, so their retention is not gated on the
    // archive — but it is the widened reader contract, not the 48h key TTL.
    const redis = await runWriter({ variant: 'finance' });
    assert.equal(
      redis.commandsOf((verb, key) => verb === 'ZREMRANGEBYSCORE' && key.includes('digest:accumulator')).length,
      1,
    );
  });
});
