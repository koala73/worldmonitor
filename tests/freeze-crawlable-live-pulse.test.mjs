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

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  function chokepointPayload(ids) {
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
        transitSummary: {
          dataAvailable: true,
          todayTotal: 0,
          todayCountsAvailable: true,
          wowChangePct: 0,
        },
      })),
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
  function stubFetch({ dropCountriesAfter = Infinity, chokepointIds = null } = {}) {
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
        return jsonResponse(chokepointPayload(chokepointIds ?? [
          'suez', 'malacca_strait', 'hormuz_strait', 'bab_el_mandeb', 'panama',
          'taiwan_strait', 'cape_of_good_hope', 'gibraltar', 'bosphorus',
          'korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait',
        ]));
      }
      if (href.includes('get-humanitarian-summary')) {
        return jsonResponse(humanitarianPayload(new URL(href).searchParams.get('country_code')));
      }
      throw new Error(`unexpected request: ${href}`);
    };
  }

  it('rejects a freeze that captured far fewer countries than the corpus renders', async () => {
    stubFetch({ dropCountriesAfter: 100 });
    await assert.rejects(
      freezeCrawlableLivePulse({ apiBase: BASE, requestGapMs: 0 }),
      /captured only 100 of \d+ countries/,
      'a 100-country capture must not pass when the corpus renders far more',
    );
  });

  it('rejects a freeze missing any chokepoint the registry defines', async () => {
    stubFetch({ chokepointIds: ['suez', 'malacca_strait', 'hormuz_strait'] });
    await assert.rejects(
      freezeCrawlableLivePulse({ apiBase: BASE, requestGapMs: 0 }),
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
      freezeCrawlableLivePulse({ apiBase: BASE, requestGapMs: 0 }),
      /captured only 0 of \d+ chokepoints/,
      'a chokepoint outage must degrade into the coverage gate, not an uncaught throw',
    );
  });

  it('preserves explicit transit-count availability in the frozen snapshot', async () => {
    stubFetch();
    const rootDir = await mkdtemp(join(tmpdir(), 'crawlable-pulse-'));
    await mkdir(join(rootDir, 'docs', 'snapshots'), { recursive: true });
    try {
      const { snapshot } = await freezeCrawlableLivePulse({
        apiBase: BASE,
        rootDir,
        requestGapMs: 0,
      });
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
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
