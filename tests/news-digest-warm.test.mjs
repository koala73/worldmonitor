import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  DIGEST_WARM_ACTIVATION_KEY,
  DIGEST_WARM_HEARTBEAT_KEY,
  DIGEST_WARM_INTERVAL_MS,
  DIGEST_WARM_REQUEST_TIMEOUT_MS,
  DIGEST_WARM_SPREAD_MS,
  buildDigestWarmUrl,
  classifyDigestWarmResponse,
  fetchDigestWarmCell,
  runDigestWarmCycle,
  shouldPublishDigestWarmHeartbeat,
  summarizeDigestWarmCycle,
} = require('../scripts/lib/news-digest-warm.cjs');

const cells = JSON.parse(readFileSync(join(root, 'scripts/shared/news-digest-warm-cells.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(root, 'shared/news-catalog.json'), 'utf8'));
const editions = JSON.parse(readFileSync(join(root, 'scripts/shared/news-digest-editions.json'), 'utf8'));

const coverage = (overrides = {}) => ({
  coverage: { state: 'complete', feedTotal: 40, feedCompleted: 38, servedStale: false, staleReason: '', ...overrides },
});

describe('warm cells', () => {
  const key = (cell) => `${cell.edition}:${cell.lang}`;
  const cellKeys = new Set(cells.map(key));

  it('pairs every edition with each language it places a server feed in, and nothing else', () => {
    const expected = new Set();
    for (const feed of catalog.feeds) {
      for (const placement of feed.placements) {
        if (placement.serverOrder === undefined) continue;
        // Intel feeds build with the full digest.
        const edition = placement.edition === 'intel' ? 'full' : placement.edition;
        expected.add(`${edition}:${feed.lang ?? 'en'}`);
      }
    }
    assert.deepEqual([...cellKeys].sort(), [...expected].sort());
  });

  it('includes full:fr because full places a French feed, and no pair without a feed in that language', () => {
    assert.ok(cellKeys.has('full:fr'));
    assert.ok(!cellKeys.has('tech:fr'), 'tech places no French server feed');
  });

  it('covers every digest edition, and each pair is a valid digest request', () => {
    assert.deepEqual([...new Set(cells.map((cell) => cell.edition))].sort(), [...editions].sort());
    assert.equal(cellKeys.size, cells.length, 'duplicate cells');
    for (const cell of cells) assert.match(cell.lang, /^[a-z]{2}$/);
  });

  it('waits longer than the digest cache TTL plus a request, so every request rebuilds its cell', () => {
    const digest = readFileSync(join(root, 'server/worldmonitor/news/v1/list-feed-digest.ts'), 'utf8');
    const match = digest.match(/cachedFetchJsonWithMeta<ListFeedDigestResponse>\(\s*digestCacheKey,\s*(\d+),/);
    assert.ok(match, 'digest cache TTL not found');
    assert.ok(DIGEST_WARM_INTERVAL_MS > Number(match[1]) * 1000 + DIGEST_WARM_REQUEST_TIMEOUT_MS);
  });

  it('starts the last request early enough for it to finish inside the interval', () => {
    assert.ok(DIGEST_WARM_SPREAD_MS + DIGEST_WARM_REQUEST_TIMEOUT_MS < DIGEST_WARM_INTERVAL_MS);
  });
});

describe('buildDigestWarmUrl', () => {
  it('requests the cell through the API base the classify loop uses', () => {
    assert.equal(
      buildDigestWarmUrl({ edition: 'full', lang: 'pt' }, { API_BASE_URL: 'http://worldmonitor:3000/' }),
      'http://worldmonitor:3000/api/news/v1/list-feed-digest?variant=full&lang=pt',
    );
    assert.equal(
      buildDigestWarmUrl({ edition: 'energy', lang: 'en' }, {}),
      'https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=energy&lang=en',
    );
  });
});

describe('classifyDigestWarmResponse', () => {
  it('reads a current build as fresh with its feed counts', () => {
    assert.deepEqual(classifyDigestWarmResponse(200, coverage()), {
      outcome: 'fresh', reason: '', feedTotal: 40, feedCompleted: 38,
    });
  });

  it('reads a last-good replay as stale and an empty digest as failed', () => {
    assert.equal(classifyDigestWarmResponse(200, coverage({ servedStale: true, staleReason: 'narrower-categories' })).outcome, 'stale');
    assert.deepEqual(classifyDigestWarmResponse(200, coverage({ state: 'unavailable', staleReason: 'build-error' })), {
      outcome: 'failed', reason: 'build-error', feedTotal: 40, feedCompleted: 38,
    });
  });

  it('fails a non-2xx status or a body without coverage', () => {
    assert.deepEqual(classifyDigestWarmResponse(401, null), { outcome: 'failed', reason: 'http-401' });
    assert.deepEqual(classifyDigestWarmResponse(200, { categories: {} }), { outcome: 'failed', reason: 'malformed' });
  });
});

describe('fetchDigestWarmCell', () => {
  it('sends the relay key and user agent', async () => {
    let seen;
    const result = await fetchDigestWarmCell({ edition: 'full', lang: 'de' }, {
      env: {},
      userAgent: 'test-agent',
      relayKey: 'relay-secret',
      fetchImpl: async (url, init) => {
        seen = { url, headers: init.headers, redirect: init.redirect };
        return { ok: true, status: 200, json: async () => coverage() };
      },
    });
    assert.equal(result.outcome, 'fresh');
    assert.equal(seen.url, 'https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=de');
    assert.equal(seen.headers['X-WorldMonitor-Key'], 'relay-secret');
    assert.equal(seen.headers['User-Agent'], 'test-agent');
    assert.equal(seen.redirect, 'error', 'a redirect must not carry the relay key to another origin');
  });

  it('turns a thrown fetch into a failed cell', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const result = await fetchDigestWarmCell({ edition: 'full', lang: 'de' }, {
      env: {},
      fetchImpl: async () => { throw timeout; },
    });
    assert.deepEqual(result, { outcome: 'failed', reason: 'timeout' });
  });
});

describe('runDigestWarmCycle', () => {
  const fakeClock = () => {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  };

  it('starts requests evenly across the spread without waiting for earlier ones', async () => {
    const clock = fakeClock();
    const startedAt = [];
    const release = [];
    const run = runDigestWarmCycle(
      [{ edition: 'full', lang: 'en' }, { edition: 'full', lang: 'fr' }, { edition: 'tech', lang: 'en' }],
      {
        ...clock,
        spreadMs: 600_000,
        // Requests stay pending until released, so a sequential cycle would hang.
        fetchCell: () => {
          startedAt.push(clock.now());
          return new Promise((resolve) => release.push(() => resolve({ outcome: 'fresh', reason: '' })));
        },
      },
    );
    while (release.length < 3) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(startedAt.map((t) => t - 1_000_000), [0, 300_000, 600_000]);
    for (const resolve of release) resolve();
    const results = await run;
    assert.deepEqual(results.map((r) => `${r.edition}:${r.lang}:${r.outcome}`), ['full:en:fresh', 'full:fr:fresh', 'tech:en:fresh']);
  });

  it('counts a failing request and keeps going', async () => {
    const clock = fakeClock();
    const results = await runDigestWarmCycle(
      [{ edition: 'full', lang: 'en' }, { edition: 'full', lang: 'pt' }, { edition: 'full', lang: 'de' }],
      {
        ...clock,
        fetchCell: async (cell) => {
          if (cell.lang === 'pt') throw new Error('boom');
          return { outcome: 'fresh', reason: '', feedTotal: 10, feedCompleted: 9 };
        },
      },
    );
    const summary = summarizeDigestWarmCycle(results, { fetchedAt: 1, durMs: 2 });
    assert.equal(summary.fresh, 2);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.failures, ['full:pt:error']);
    assert.deepEqual(summary.languages.de, { cells: 1, served: 1, feedTotal: 10, feedCompleted: 9 });
    assert.deepEqual(summary.languages.pt, { cells: 1, served: 0, feedTotal: 0, feedCompleted: 0 });
  });
});

describe('heartbeat', () => {
  const summary = (outcomes) => summarizeDigestWarmCycle(
    outcomes.map((outcome, i) => ({ edition: 'full', lang: `l${i}`, outcome, reason: outcome === 'fresh' ? '' : 'x' })),
    { fetchedAt: 1, durMs: 1 },
  );

  it('vouches for a cycle where at least half the cells served news', () => {
    assert.equal(shouldPublishDigestWarmHeartbeat(summary(['fresh', 'stale', 'failed', 'failed'])), true);
    assert.equal(summary(['fresh', 'stale', 'failed', 'failed']).recordCount, 2);
  });

  it('withholds the heartbeat when most cells failed or there were none', () => {
    assert.equal(shouldPublishDigestWarmHeartbeat(summary(['fresh', 'failed', 'failed'])), false);
    assert.equal(shouldPublishDigestWarmHeartbeat(summary([])), false);
  });

  it('is the key health probes, with the activation marker health softens on', () => {
    const health = readFileSync(join(root, 'api/health.js'), 'utf8');
    assert.ok(health.includes(`newsDigestWarmRelayHeartbeat: '${DIGEST_WARM_HEARTBEAT_KEY}'`));
    assert.ok(health.includes(`activationKey: '${DIGEST_WARM_ACTIVATION_KEY}'`));
    assert.ok(health.includes('newsDigestWarmRelayHeartbeat: SEED_META.newsDigestWarmRelayHeartbeat.activationKey'));
  });
});

describe('relay wiring', () => {
  const relay = readFileSync(join(root, 'scripts/ais-relay.cjs'), 'utf8');
  const dockerfile = readFileSync(join(root, 'Dockerfile.relay'), 'utf8');

  it('starts the warm loop over the generated cells', () => {
    assert.match(relay, /const DIGEST_WARM_CELLS = requireShared\('news-digest-warm-cells\.json'\);/);
    assert.match(relay, /^ {2}startDigestWarmLoop\(\);$/m);
  });

  it('ships the module and the cell list in the relay image', () => {
    assert.ok(dockerfile.includes('COPY scripts/lib/news-digest-warm.cjs ./scripts/lib/news-digest-warm.cjs'));
    assert.ok(dockerfile.includes('COPY scripts/shared/news-digest-warm-cells.json ./scripts/shared/news-digest-warm-cells.json'));
  });
});
