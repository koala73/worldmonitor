import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  authedGet,
  freezeCrawlableLivePulse,
  mintSession,
  normalizeApiBase,
} from '../scripts/freeze-crawlable-live-pulse.mjs';

describe('freeze crawlable live pulse API base routing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes trailing slashes on supplied API bases', () => {
    assert.equal(normalizeApiBase('https://staging.example/'), 'https://staging.example');
    assert.equal(normalizeApiBase('https://staging.example'), 'https://staging.example');
  });

  it('mints sessions and authenticated GETs against the supplied API base', async () => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method || 'GET',
        origin: options.headers?.Origin,
        referer: options.headers?.Referer,
        cookie: options.headers?.Cookie,
      });
      if (String(url).endsWith('/api/wm-session')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ token: 'test-token' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    };

    const base = 'https://staging.worldmonitor.test';
    const token = await mintSession(base);
    assert.equal(token, 'test-token');
    await authedGet('/api/intelligence/v1/get-country-risk?country_code=NO', token, base);

    assert.deepEqual(calls.map((call) => call.url), [
      `${base}/api/wm-session`,
      `${base}/api/intelligence/v1/get-country-risk?country_code=NO`,
    ]);
    assert.ok(calls.every((call) => call.origin === base && call.referer === `${base}/`));
    assert.equal(calls[1].cookie, 'wm-session=test-token');
  });
});

// These gates are the only thing standing between a half-captured freeze and a
// corpus that silently reverts hundreds of pages to the pre-pulse placeholder
// state. Without positive controls they can be deleted with a green CI.
describe('freeze crawlable live pulse coverage gates', () => {
  const originalFetch = globalThis.fetch;
  const BASE = 'https://staging.worldmonitor.test';
  const scratchRoots = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // Never let a freeze under test write into the checkout. A coverage gate is
  // proved by running the freeze BEFORE the gate exists, and without a scratch
  // root that run overwrites docs/snapshots/ with stub data (hit while building
  // the #7608 headline gate).
  async function scratchRoot() {
    const dir = await mkdtemp(join(tmpdir(), 'crawlable-pulse-'));
    await mkdir(join(dir, 'docs', 'snapshots'), { recursive: true });
    scratchRoots.push(dir);
    return dir;
  }

  async function runFreeze(options = {}) {
    return freezeCrawlableLivePulse({
      apiBase: BASE,
      requestGapMs: 0,
      rootDir: await scratchRoot(),
      ...options,
    });
  }

  function jsonResponse(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }

  function countryPayload() {
    return {
      upstreamUnavailable: false,
      advisoryLevel: 'normal',
      sanctionsCount: 0,
      sanctionsActive: true,
      fetchedAt: Date.now(),
      cii: undefined,
    };
  }

  function chokepointPayload(ids, descriptions = {}) {
    return {
      fetchedAt: Date.now(),
      chokepoints: ids.map((id) => ({
        id,
        disruptionScore: 10,
        status: 'green',
        activeWarnings: 0,
        navigationalWarningsAvailable: true,
        aisDisruptions: 0,
        aisSnapshotAvailable: true,
        congestionLevel: 'normal',
        description: descriptions[id],
        transitSummary: {
          dataAvailable: true,
          todayTotal: 0,
          todayCountsAvailable: true,
          wowChangePct: 0,
        },
      })),
    };
  }

  // Shaped like /api/news/v1/list-feed-digest: category buckets of NewsItem,
  // each carrying the masthead (`source`) and the article URL (`link`).
  function digestPayload(items, coverage = { state: 'complete', servedStale: false }) {
    return {
      generatedAt: new Date().toISOString(),
      // The real ListFeedDigest response always carries this block; a stub
      // without it cannot exercise the stale/degraded path at all.
      coverage: { itemsServed: items.length, ...coverage },
      categories: { politics: { items } },
    };
  }

  function digestItem(overrides = {}) {
    return {
      title: 'Outside forces fuel Sudan war, new report finds',
      source: 'UN News',
      link: 'https://news.un.org/feed/view/en/story/2026/09/1168270',
      publishedAt: Date.now() - 60 * 60 * 1000,
      importanceScore: 50,
      ...overrides,
    };
  }

  function humanitarianPayload(countryCode) {
    return {
      summary: {
        countryCode,
        updatedAt: Date.now(),
        referencePeriod: '2026-08-01',
        conflictEventsTotal: 10,
        conflictFatalities: 2,
        conflictPoliticalViolenceEvents: 3,
        conflictDemonstrations: 1,
      },
    };
  }

  /**
   * Serve a full, healthy freeze except for the parts the caller withholds.
   * `dropCountriesAfter` fails every country request past that index;
   * `chokepointIds` limits which chokepoints the upstream reports.
   */
  function stubFetch({
    dropCountriesAfter = Infinity,
    chokepointIds = null,
    chokepointDescriptions = {},
    digestItems = [
      digestItem({ title: 'Headline one', importanceScore: 90 }),
      digestItem({ title: 'Headline two', importanceScore: 80 }),
      digestItem({ title: 'Headline three', importanceScore: 70 }),
      digestItem({ title: 'Headline four', importanceScore: 60 }),
      digestItem({ title: 'Headline five', importanceScore: 50 }),
    ],
    digestCoverage = { state: 'complete', servedStale: false },
  } = {}) {
    let countriesServed = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/api/wm-session')) return jsonResponse({ token: 'test-token' });
      if (href.includes('get-country-risk')) {
        countriesServed += 1;
        if (countriesServed > dropCountriesAfter) {
          return { ok: false, status: 503, text: async () => '{}' };
        }
        return jsonResponse(countryPayload());
      }
      if (href.includes('get-chokepoint-status')) {
        return jsonResponse(chokepointPayload(
          chokepointIds ?? [
            'suez', 'malacca_strait', 'hormuz_strait', 'bab_el_mandeb', 'panama',
            'taiwan_strait', 'cape_of_good_hope', 'gibraltar', 'bosphorus',
            'korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait',
          ],
          chokepointDescriptions,
        ));
      }
      if (href.includes('get-humanitarian-summary')) {
        return jsonResponse(humanitarianPayload(new URL(href).searchParams.get('country_code')));
      }
      if (href.includes('list-feed-digest')) return jsonResponse(digestPayload(digestItems, digestCoverage));
      throw new Error(`unexpected request: ${href}`);
    };
  }

  it('rejects a freeze that captured far fewer countries than the corpus renders', async () => {
    stubFetch({ dropCountriesAfter: 100 });
    await assert.rejects(
      runFreeze(),
      /captured only 100 of \d+ countries/,
      'a 100-country capture must not pass when the corpus renders far more',
    );
  });

  it('rejects a freeze missing any chokepoint the registry defines', async () => {
    stubFetch({ chokepointIds: ['suez', 'malacca_strait', 'hormuz_strait'] });
    await assert.rejects(
      runFreeze(),
      /captured only 3 of \d+ chokepoints/,
      'a truncated chokepoint list must fail rather than ship placeholder pages',
    );
  });

  it('survives a chokepoint-status outage without discarding the country work', async () => {
    stubFetch();
    const outer = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('get-chokepoint-status')) throw new Error('offline');
      return outer(url);
    };
    // The run must fail on the coverage gate (0 chokepoints), NOT on an
    // unhandled rejection from the single unguarded fetch.
    await assert.rejects(
      runFreeze(),
      /captured only 0 of \d+ chokepoints/,
      'a chokepoint outage must degrade into the coverage gate, not an uncaught throw',
    );
  });

  it('preserves explicit transit-count availability in the frozen snapshot', async () => {
    stubFetch();
    const { snapshot } = await runFreeze();
    assert.ok(Object.values(snapshot.chokepoints).length > 0);
    assert.ok(
      Object.values(snapshot.chokepoints).every((pulse) => (
        pulse.todayTransits === '0'
        && pulse.todayCountsAvailable === true
        && pulse.navigationalWarnings === '0 warnings'
        && pulse.navigationalWarningsAvailable === true
        && pulse.aisDisruptions === '0 AIS disruptions'
        && pulse.aisSnapshotAvailable === true
        && pulse.congestion === 'Normal'
        && pulse.weekMovement === '0% vs prior week'
      )),
    );
  });

  // The homepage teaser strip renders whatever this freeze captures into the
  // SEO prerender, masthead attached. Four invented headlines carrying real
  // Reuters/FT/AP/BBC bylines shipped that way for months (#7608), so every
  // gate below exists to make an unattributable or unverifiable headline fail
  // the freeze rather than reach a crawler.
  it('captures the top headlines with masthead, article URL and publication time', async () => {
    const publishedAt = Date.now() - 90 * 60 * 1000;
    stubFetch({
      digestItems: [
        digestItem({ title: 'Third', importanceScore: 30 }),
        digestItem({
          title: 'First',
          source: 'UN News',
          link: 'https://news.un.org/story/1',
          publishedAt,
          importanceScore: 90,
        }),
        digestItem({ title: 'Second', importanceScore: 60 }),
        digestItem({ title: 'Fourth', importanceScore: 20 }),
        digestItem({ title: 'Fifth', importanceScore: 10 }),
      ],
    });
    const { snapshot } = await runFreeze();
    assert.equal(snapshot.headlines.length, 4, 'the strip renders exactly four headlines');
    assert.deepEqual(
      snapshot.headlines.map((h) => h.title),
      ['First', 'Second', 'Third', 'Fourth'],
      'headlines must be ranked by importance, matching the live card',
    );
    assert.deepEqual(snapshot.headlines[0], {
      title: 'First',
      source: 'UN News',
      url: 'https://news.un.org/story/1',
      publishedAt: new Date(publishedAt).toISOString(),
    });
    assert.equal(snapshot.coverage.headlineCount, 4);
  });

  // A thin headline capture must cost the strip its rows, never the snapshot.
  // The headline step runs last, just before the only write, so throwing here
  // would discard ~196 captured countries — and two such runs in a row would
  // push the snapshot past the corpus build's 10-day ceiling and hard-fail
  // every country, chokepoint and crisis page.
  it('keeps the country capture when the digest yields no publishable headline', async () => {
    stubFetch({ digestItems: [] });
    const { snapshot } = await runFreeze();
    assert.deepEqual(snapshot.headlines, [], 'an empty capture publishes nothing, never stale rows');
    assert.equal(snapshot.coverage.headlineCount, 0);
    assert.ok(
      snapshot.coverage.countryCount > 100,
      'the country capture must survive a headline shortfall',
    );
    assert.match(
      snapshot.errors.headlines[0].message,
      /only 0 of 4 digest items were publishable/,
      'the shortfall must be recorded with its cause, not silently dropped',
    );
  });

  it('records why unattributable digest items were rejected', async () => {
    stubFetch({
      digestItems: [
        digestItem({ title: 'No masthead', source: '' }),
        digestItem({ title: 'No link', link: '' }),
        digestItem({ title: 'Insecure link', link: 'http://example.test/a' }),
        digestItem({ title: 'No publication time', publishedAt: 0 }),
        digestItem({
          title: 'Aggregator redirect - New Lines Magazine',
          link: 'https://news.google.com/rss/articles/CBMifzFBVV95cUx',
        }),
        digestItem({ title: 'Keeps its provenance' }),
      ],
    });
    const { snapshot } = await runFreeze();
    assert.deepEqual(
      snapshot.headlines.map((h) => h.title),
      ['Keeps its provenance'],
      'only the item with a masthead, a verifiable https link and a publication time survives',
    );
    // A bare count says a refresh went thin but never why. The request itself
    // succeeded here, so without per-reason tallies the operator sees nothing.
    assert.match(snapshot.errors.headlines[0].message, /noSource=1/);
    assert.match(snapshot.errors.headlines[0].message, /unverifiableUrl=3/);
    assert.match(snapshot.errors.headlines[0].message, /noPublishedAt=1/);
  });

  it('survives a digest outage without discarding the country work', async () => {
    stubFetch();
    const outer = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('list-feed-digest')) throw new Error('offline');
      return outer(url);
    };
    const { snapshot } = await runFreeze();
    assert.deepEqual(snapshot.headlines, []);
    assert.equal(snapshot.errors.headlines[0].message, 'offline');
    assert.ok(snapshot.coverage.countryCount > 100, 'a news outage must not cost the corpus its refresh');
  });

  // Four well-formed rows off a six-hour-old last-good replay are
  // indistinguishable from a complete capture unless the digest's own verdict
  // survives into the artifact.
  it('carries the digest own stale verdict into the snapshot', async () => {
    stubFetch({ digestCoverage: { state: 'stale', servedStale: true } });
    const { snapshot } = await runFreeze();
    assert.equal(snapshot.coverage.headlineCount, 4);
    assert.equal(snapshot.coverage.headlineDigestState, 'stale');
    assert.equal(snapshot.coverage.headlineServedStale, true);
  });

  it('omits the upstream no-active-disruptions boilerplate from frozen chokepoints', async () => {
    stubFetch({ chokepointDescriptions: { malacca_strait: 'No active disruptions' } });
    const { snapshot } = await runFreeze();
    assert.equal(snapshot.chokepoints.malacca_strait.description, null);
  });
});
