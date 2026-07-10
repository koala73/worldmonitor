// #4920: completeness measurement — feed-health payload/silent-zeros,
// recall benchmark math, selection-gate drop stats, coverage-ledger and
// provenance wiring.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFeedHealthPayload,
  isGoogleNewsWrapper,
  SILENT_ZERO_THRESHOLD,
} from '../scripts/_feed-health.mjs';
import { computeRecall } from '../scripts/_recall-benchmark-core.mjs';
import { selectTopStories } from '../scripts/_clustering.mjs';
import { extractServerFeeds } from '../scripts/validate-rss-feeds.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

const GN = 'https://news.google.com/rss/search?q=site%3Areuters.com&hl=en-US&gl=US&ceid=US:en';

describe('feed-health payload (#4920a)', () => {
  it('classifies wrappers and counts statuses', () => {
    const payload = buildFeedHealthPayload([
      { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', status: 'OK', catalog: 'both' },
      { name: 'Reuters GN', url: GN, status: 'EMPTY', catalog: 'server' },
      { name: 'Dead Feed', url: 'https://example.com/rss', status: 'DEAD', detail: 'Timeout (15s)' },
    ], null, 1_000);
    assert.equal(payload.summary.ok, 1);
    assert.equal(payload.summary.empty, 1);
    assert.equal(payload.summary.dead, 1);
    assert.equal(payload.feeds[GN].wrapper, true);
    assert.equal(payload.feeds[GN].consecutiveEmpty, 1);
    assert.deepEqual(payload.silentZeros, [], 'one empty run is not yet a silent zero');
  });

  it('silent zero fires for a wrapper after consecutive empty runs, and resets on recovery', () => {
    const run1 = buildFeedHealthPayload([{ name: 'R', url: GN, status: 'EMPTY' }], null, 1);
    const run2 = buildFeedHealthPayload([{ name: 'R', url: GN, status: 'EMPTY' }], run1, 2);
    assert.equal(run2.feeds[GN].consecutiveEmpty, SILENT_ZERO_THRESHOLD);
    assert.equal(run2.silentZeros.length, 1, 'wrapper empty across runs = silent zero');

    const run3 = buildFeedHealthPayload([{ name: 'R', url: GN, status: 'OK' }], run2, 3);
    assert.equal(run3.feeds[GN].consecutiveEmpty, 0, 'recovery resets the streak');
    assert.deepEqual(run3.silentZeros, []);
  });

  it('non-wrapper feeds never appear in silentZeros regardless of streak', () => {
    const url = 'https://example.com/rss';
    let prev = null;
    for (let i = 0; i < 4; i++) {
      prev = buildFeedHealthPayload([{ name: 'X', url, status: 'EMPTY' }], prev, i);
    }
    assert.equal(prev.feeds[url].consecutiveEmpty, 4);
    assert.deepEqual(prev.silentZeros, [], 'silent-zero is a wrapper-specific signal');
  });

  it('isGoogleNewsWrapper matches search wrappers only', () => {
    assert.equal(isGoogleNewsWrapper(GN), true);
    assert.equal(isGoogleNewsWrapper('https://feeds.bbci.co.uk/news/world/rss.xml'), false);
  });
});

describe('recall benchmark math (#4920c)', () => {
  const digest = [
    'Iran threatens to close Strait of Hormuz if US blockade continues',
    'Turkey hikes interest rates to 50% in surprise move',
    'Magnitude 6.8 earthquake strikes northern Chile',
  ];

  it('matches edit-variants of carried stories and reports misses with evidence', () => {
    const external = [
      { title: 'Iran threatens to close Strait of Hormuz — live updates', url: 'https://a' },
      { title: 'Turkey hikes rates to 50% in surprise move', url: 'https://b' },
      { title: 'Nigeria fuel subsidy protests spread to Lagos', url: 'https://c' },
    ];
    const result = computeRecall(external, digest);
    assert.equal(result.matched, 2);
    assert.equal(result.total, 3);
    assert.equal(result.recallPct, 66.7);
    assert.equal(result.missed.length, 1);
    assert.match(result.missed[0].title, /Nigeria/);
    assert.ok(result.missed[0].bestScore < result.threshold);
  });

  it('excludes unvectorizable external titles from the denominator', () => {
    const result = computeRecall(
      [{ title: '!!!' }, { title: 'Turkey hikes rates to 50% in surprise move' }],
      digest,
    );
    assert.equal(result.total, 1);
    assert.equal(result.unvectorizable, 1);
    assert.equal(result.recallPct, 100);
  });

  it('empty external set yields null recall, never NaN', () => {
    const result = computeRecall([], digest);
    assert.equal(result.recallPct, null);
  });
});

describe('selectTopStories drop stats (#4920b)', () => {
  const mkCluster = (title, source, sources = 1, score = 150) => ({
    primaryTitle: title,
    primarySource: source,
    primaryLink: 'https://x',
    pubDate: new Date().toISOString(),
    sources: Array.from({ length: sources }, (_, i) => `${source}-${i}`),
    // High tier + alert to clear admissibility deterministically
    isAlert: score > 100,
    tier: 1,
  });

  it('populates considered/admissibility/sourceCap counters', () => {
    const clusters = [
      mkCluster('Iran threatens Hormuz closure blockade', 'Reuters', 3),
      mkCluster('Turkey hikes interest rates surprise move', 'Reuters', 2),
      mkCluster('Chile earthquake magnitude strikes north', 'Reuters', 2),
      mkCluster('Kenya protests spread across Nairobi city', 'Reuters', 2),
      mkCluster('Totally inadmissible single-source story here', 'BlogX', 1, 10),
    ];
    // Make the last one inadmissible: single source, no alert, low score
    clusters[4].isAlert = false;
    const stats = {};
    const selected = selectTopStories(clusters, 8, stats);
    assert.equal(stats.considered, 5);
    assert.ok(stats.admissibilityDropped >= 1, 'single-source low-score cluster dropped');
    assert.ok(stats.sourceCapDropped >= 1, 'fourth same-source cluster hits MAX_PER_SOURCE=3');
    assert.ok(selected.length <= 8);
  });

  it('stats argument is optional (call sites without it keep working)', () => {
    assert.doesNotThrow(() => selectTopStories([], 8));
  });
});

describe('server catalog extraction (#4920a)', () => {
  it('extracts the digest feed catalog with rebuilt Google News URLs', () => {
    const feeds = extractServerFeeds();
    assert.ok(feeds.length > 250, `expected 250+ server feeds, got ${feeds.length}`);
    const wrapper = feeds.find((f) => f.url.includes('news.google.com'));
    assert.ok(wrapper, 'gn() URLs must be rebuilt');
    assert.match(wrapper.url, /^https:\/\/news\.google\.com\/rss\/search\?q=.+&hl=/);
    assert.ok(feeds.every((f) => f.catalog === 'server'));
  });

  it('extracts double-quoted names (Tom\'s Hardware class — #4927 cross-model)', () => {
    const feeds = extractServerFeeds();
    assert.ok(feeds.some((f) => f.name === "Tom's Hardware"), 'double-quoted names must not be skipped');
  });
});

describe('coverage-ledger and provenance wiring (source-textual)', () => {
  it('digest counts every drop gate and publishes the ledger', () => {
    const src = readSrc('server/worldmonitor/news/v1/list-feed-digest.ts');
    assert.match(src, /droppedFeedCap = Math\.max\(0, matches\.length - ITEMS_PER_FEED\)/);
    assert.match(src, /ledgerDrops\.perCategoryCap \+= Math\.max\(0, items\.length - MAX_ITEMS_PER_CATEGORY\)/);
    assert.match(src, /ledgerDrops\.freshnessFloor = droppedStaleTotal/);
    assert.match(src, /news:coverage-ledger:v1/);
  });

  it('insights payload carries provenance and the panel renders it', () => {
    const seedSrc = readSrc('scripts/seed-insights.mjs');
    assert.match(seedSrc, /storiesConsidered: normalizedItems\.length/);
    assert.match(seedSrc, /selectTopStories\(clusters, 8, selectionStats\)/);
    const panelSrc = readSrc('src/components/InsightsPanel.ts');
    assert.match(panelSrc, /components\.insights\.compiledFrom/);
    const en = JSON.parse(readSrc('src/locales/en.json'));
    assert.match(en.components.insights.compiledFrom, /\{\{stories\}\}.*\{\{sources\}\}/);
  });

  it('both completeness keys are registered in health surfaces', () => {
    const seedHealth = readSrc('api/seed-health.js');
    assert.match(seedHealth, /'news:feed-health'/);
    assert.match(seedHealth, /'news:recall-benchmark'/);
    const health = readSrc('api/health.js');
    assert.match(health, /news:feed-health:v1/);
    assert.match(health, /seed-meta:news:recall-benchmark/);
  });

  it('workflow passes Upstash secrets to both publishers', () => {
    const wf = readSrc('.github/workflows/feed-validation.yml');
    assert.match(wf, /UPSTASH_REDIS_REST_URL/);
    assert.match(wf, /seed-recall-benchmark\.mjs/);
  });
});

// ── #4927 review-round additions ───────────────────────────────────────────

import { unwrapEnvelope, gdeltUrl } from '../scripts/seed-recall-benchmark.mjs';
import { publishFeedHealth } from '../scripts/validate-rss-feeds.mjs';
import { getOptionalUpstashCreds } from '../scripts/_upstash-rest.mjs';

describe('gn()/gnLocale() replica drift guard (#4927 review)', () => {
  it('extractServerFeeds URL builders textually match the _feeds.ts source', () => {
    const feedsSrc = readSrc('server/worldmonitor/news/v1/_feeds.ts');
    const validatorSrc = readSrc('scripts/validate-rss-feeds.mjs');
    // The load-bearing template expressions must appear byte-identical in
    // both files — a change to gn()'s URL shape in _feeds.ts without the
    // replica following makes the health report validate URLs the digest
    // never fetches.
    const gnTemplate = 'https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en';
    const gnLocaleTemplate = 'https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}';
    for (const template of [gnTemplate, gnLocaleTemplate]) {
      assert.ok(feedsSrc.includes(template), `_feeds.ts must contain: ${template}`);
      assert.ok(validatorSrc.includes(template), `validate-rss-feeds replica must contain: ${template}`);
    }
  });
});

describe('selectTopStories overflow stat (#4927 review)', () => {
  it('counts admissible clusters that never fit under maxCount', () => {
    const clusters = Array.from({ length: 12 }, (_, i) => ({
      primaryTitle: `Distinct breaking story number ${i} about topic ${i}`,
      primarySource: `Source${i}`,
      primaryLink: `https://x/${i}`,
      pubDate: new Date().toISOString(),
      sources: [`Source${i}`, `Other${i}`],
      isAlert: true,
      tier: 1,
    }));
    const stats = {};
    const selected = selectTopStories(clusters, 8, stats);
    assert.equal(selected.length, 8);
    assert.equal(stats.overflowDropped, 4, '12 admissible distinct-source clusters, 8 slots → 4 overflow');
    assert.equal(stats.sourceCapDropped, 0);
  });
});

describe('publisher orchestration seams (#4927 review)', () => {
  it('publishFeedHealth skips cleanly without credentials', async () => {
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const out = await publishFeedHealth([{ name: 'X', url: 'https://x/rss', status: 'OK' }]);
      assert.deepEqual(out, { published: false, reason: 'no-creds' });
      assert.equal(getOptionalUpstashCreds(), null);
    } finally {
      if (prevUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    }
  });

  it('gdeltUrl builds a bounded, English, 24h ArtList query', () => {
    const url = gdeltUrl('(economy OR markets)');
    assert.match(url, /^https:\/\/api\.gdeltproject\.org\/api\/v2\/doc\/doc\?/);
    assert.match(url, /sourcelang%3Aeng/);
    assert.match(url, /maxrecords=25/);
    assert.match(url, /timespan=24h/);
  });

  it('unwrapEnvelope tolerates enveloped and bare payloads', () => {
    assert.deepEqual(unwrapEnvelope({ data: { a: 1 }, fetchedAt: 5 }), { a: 1 });
    assert.deepEqual(unwrapEnvelope({ categories: {} }), { categories: {} });
    assert.equal(unwrapEnvelope(null), null);
  });
});

describe('locale integrity for provenance keys (#4927 review)', () => {
  it('every parity-tested locale carries compiledFrom with double-brace tokens', () => {
    const fs = readdirSyncLocales();
    for (const file of fs) {
      const d = JSON.parse(readSrc(`src/locales/${file}`));
      const val = d?.components?.insights?.compiledFrom;
      assert.ok(typeof val === 'string' && val.length > 0, `${file} missing compiledFrom`);
      assert.ok(val.includes('{{stories}}') && val.includes('{{sources}}'),
        `${file} compiledFrom must keep {{stories}}/{{sources}} tokens, got: ${val}`);
    }
  });
});

import { readdirSync } from 'node:fs';
function readdirSyncLocales() {
  return readdirSync(resolve(root, 'src/locales'))
    .filter((f) => f.endsWith('.json') && f !== 'en.shell.json');
}

describe('feed-health streak continuity (#4927 external review)', () => {
  it('a failed previous-state read skips publish instead of resetting streaks', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
    try {
      const out = await publishFeedHealth([{ name: 'X', url: 'https://x/rss', status: 'EMPTY' }]);
      assert.deepEqual(out, { published: false, reason: 'previous-read-failed' });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });
});

describe('selection attribution: same-source overflow (#4927 re-review)', () => {
  it('REGRESSION: candidates past maxCount are cap-attributed when their source already hit the cap', () => {
    const pubDate = '2026-01-01T00:00:00.000Z';
    const mk = (title, source) => ({
      primaryTitle: title, primarySource: source, primaryLink: `https://x/${title}`,
      pubDate, sources: [source, 'Wire'], isAlert: true, tier: 1,
    });
    // 3 selected from SameSource (hits MAX_PER_SOURCE), then 2 distinct fill
    // maxCount=5; then: 1 more SameSource (cap drop even though selection is
    // full) + 2 distinct (genuine overflow).
    const clusters = [
      mk('s1', 'SameSource'), mk('s2', 'SameSource'), mk('s3', 'SameSource'),
      mk('d1', 'A'), mk('d2', 'B'),
      mk('s4', 'SameSource'),
      mk('d3', 'C'), mk('d4', 'D'),
    ];
    const stats = {};
    const selected = selectTopStories(clusters, 5, stats);
    assert.equal(selected.length, 5);
    assert.equal(stats.sourceCapDropped, 1, 's4 is a source-cap drop, not overflow');
    assert.equal(stats.overflowDropped, 2, 'only genuinely rankable candidates count as overflow');
    assert.equal(stats.admissibilityDropped + stats.sourceCapDropped + stats.overflowDropped + selected.length, clusters.length,
      'every considered cluster is attributed exactly once');
  });
});

describe('durable activation lifecycle (#4927 re-review P1)', () => {
  it('classifyKey: on-demand softening is revoked once the activation marker exists', async () => {
    const { __testing__ } = await import('../api/health.js');
    const { classifyKey, ACTIVATION_MARKERS } = __testing__;
    assert.ok(ACTIVATION_MARKERS.newsFeedHealth.startsWith('seed-activated:'), 'marker namespace pinned');

    const baseCtx = {
      keyStrens: new Map([['news:feed-health:v1', 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map(),
      keyMetaErrors: new Map(),
      now: Date.now(),
    };
    // Never activated: missing data reads soft EMPTY_ON_DEMAND.
    const pending = classifyKey('newsFeedHealth', 'news:feed-health:v1', { allowOnDemand: true },
      { ...baseCtx, activatedNames: new Set() });
    assert.equal(pending.status, 'EMPTY_ON_DEMAND');
    // Activated then died (marker present, data+meta expired): must alarm.
    const dead = classifyKey('newsFeedHealth', 'news:feed-health:v1', { allowOnDemand: true },
      { ...baseCtx, activatedNames: new Set(['newsFeedHealth']) });
    assert.equal(dead.status, 'EMPTY', 'post-activation missing data must be EMPTY, not softened');
  });

  it('publishers persist the durable marker with NO TTL alongside every publish', () => {
    const feedSrc = readSrc('scripts/validate-rss-feeds.mjs');
    assert.match(feedSrc, /\['SET', 'seed-activated:news:feed-health', '1'\]/,
      'feed-health publisher must SET the marker');
    assert.doesNotMatch(feedSrc, /'seed-activated:news:feed-health', '1', 'EX'/,
      'marker must be durable — no TTL');
    const recallSrc = readSrc('scripts/seed-recall-benchmark.mjs');
    assert.match(recallSrc, /\['SET', 'seed-activated:news:recall-benchmark', '1'\]/);
    const seedHealthSrc = readSrc('api/seed-health.js');
    assert.match(seedHealthSrc, /activationKey: 'seed-activated:news:feed-health'/,
      'seed-health gates pending-activation on the marker');
    assert.match(seedHealthSrc, /cfg\.activationKey && !activatedMap\.get\(domain\)/,
      'missing meta with marker present must fall through to missing/stale');
  });
});
