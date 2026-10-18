import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cacheControlForEmbedFrame,
  composeEmbedMapFrame,
  entitledLayersForTier,
  parseRequestedLayers,
  refreshMsForTier,
  type EmbedMapFrameSources,
} from '../server/_shared/embed-map-frame';
import {
  buildPublicEmbedFrameSearch,
  canonicalizeEmbedLayers,
  classifyPublicEmbedFrameRequest,
  EMBED_MAP_FRAME_PATH,
} from '../shared/embed-map-frame';
import { EMBED_LAYER_IDS, EMBED_KEYED_REFRESH_MS, EMBED_FREE_REFRESH_MS } from '../shared/embed-panels';
import {
  handleEmbedMapFrame,
  type EmbedMapFrameHandlerDeps,
} from '../api/embed/map-frame';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;

function sources(overrides: Partial<EmbedMapFrameSources> = {}): EmbedMapFrameSources {
  return {
    listConflicts: async () => [{ id: 'c1' }],
    listEarthquakes: async () => [{ id: 'q1' }],
    listNaturalEvents: async () => [{ id: 'n1' }],
    listProtests: async () => [{ id: 'p1' }],
    listWeatherAlerts: async () => [{ id: 'w1' }],
    ...overrides,
  };
}

/** Counts calls so a test can prove an upstream was never touched. */
function countingSources(overrides: Partial<EmbedMapFrameSources> = {}) {
  const calls: string[] = [];
  const base = sources();
  const wrapped = Object.fromEntries(
    (Object.keys(base) as (keyof EmbedMapFrameSources)[]).map((key) => [
      key,
      async () => {
        calls.push(key);
        return (overrides[key] ?? base[key])();
      },
    ]),
  ) as EmbedMapFrameSources;
  return { calls, sources: wrapped };
}

describe('embed map frame', () => {
  describe('requested layers', () => {
    it('accepts the allowlist and drops everything else', () => {
      assert.deepEqual(
        parseRequestedLayers('conflicts,weather,cables'),
        ['conflicts', 'weather', 'cables'],
      );
      assert.deepEqual(parseRequestedLayers('conflicts,nuclear,military,ais'), ['conflicts']);
      assert.deepEqual(parseRequestedLayers('__proto__,constructor'), []);
    });

    it('normalises duplicates and whitespace so the cache key does not fragment', () => {
      assert.deepEqual(
        parseRequestedLayers(' conflicts , conflicts,  weather '),
        ['conflicts', 'weather'],
      );
    });

    it('falls back to the free trio when the parameter is absent or blank', () => {
      assert.deepEqual(parseRequestedLayers(null), ['conflicts', 'earthquakes', 'weather']);
      assert.deepEqual(parseRequestedLayers(''), ['conflicts', 'earthquakes', 'weather']);
      assert.deepEqual(parseRequestedLayers('   '), ['conflicts', 'earthquakes', 'weather']);
    });
  });

  describe('tiers', () => {
    it('entitles three layers free and all fourteen keyed', () => {
      assert.deepEqual([...entitledLayersForTier('free')], ['conflicts', 'earthquakes', 'weather']);
      assert.deepEqual([...entitledLayersForTier('keyed')], [...EMBED_LAYER_IDS]);
    });

    it('takes each cadence from the registry', () => {
      assert.equal(refreshMsForTier('free'), EMBED_FREE_REFRESH_MS);
      assert.equal(refreshMsForTier('keyed'), EMBED_KEYED_REFRESH_MS);
    });

    it('serves the three free layers to a keyless caller', async () => {
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'earthquakes', 'weather'],
        'free',
        sources(),
        NOW,
      );
      assert.equal(frame.tier, 'free');
      assert.equal(frame.refreshMs, EMBED_FREE_REFRESH_MS);
      assert.equal(frame.generatedAt, NOW);
      assert.deepEqual(frame.layers, { conflicts: 'ok', earthquakes: 'ok', weather: 'ok' });
      assert.deepEqual(frame.data.conflicts, [{ id: 'c1' }]);
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.deepEqual(frame.data.naturalEvents, [{ id: 'n1' }]);
      assert.deepEqual(frame.data.weatherAlerts, [{ id: 'w1' }]);
      assert.equal(frame.data.protests, undefined);
    });

    it('marks a paid layer not-entitled for a keyless caller and withholds its data', async () => {
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'protests', 'cables'],
        'free',
        sources(),
        NOW,
      );
      assert.equal(frame.layers.conflicts, 'ok');
      assert.equal(frame.layers.protests, 'not-entitled');
      assert.equal(frame.layers.cables, 'not-entitled');
      assert.equal(frame.data.protests, undefined);
    });

    it('does not spend an upstream read on an unentitled layer', async () => {
      const { calls, sources: counting } = countingSources();
      await composeEmbedMapFrame(['conflicts', 'protests'], 'free', counting, NOW);
      assert.deepEqual(calls, ['listConflicts']);
      assert.equal(
        calls.includes('listProtests'),
        false,
        'the free tier must not fund a paid layer’s upstream',
      );
    });

    it('serves every requested layer to a keyed caller', async () => {
      const frame = await composeEmbedMapFrame([...EMBED_LAYER_IDS], 'keyed', sources(), NOW);
      assert.equal(frame.tier, 'keyed');
      assert.equal(frame.refreshMs, EMBED_KEYED_REFRESH_MS);
      for (const id of EMBED_LAYER_IDS) {
        assert.equal(frame.layers[id], 'ok', `${id} should be served to a keyed caller`);
      }
      assert.deepEqual(frame.data.protests, [{ id: 'p1' }]);
    });

    it('answers static layers without an upstream read', async () => {
      const { calls } = countingSources();
      const { sources: counting, calls: staticCalls } = countingSources();
      const frame = await composeEmbedMapFrame(['cables', 'pipelines'], 'keyed', counting, NOW);
      assert.deepEqual(frame.layers, { cables: 'ok', pipelines: 'ok' });
      assert.deepEqual(staticCalls, []);
      assert.deepEqual(calls, []);
      assert.deepEqual(frame.data, {});
    });
  });

  describe('partial upstream failure', () => {
    it('ships one failed layer as state rather than failing the frame', async () => {
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'earthquakes', 'weather'],
        'free',
        sources({ listWeatherAlerts: async () => { throw new Error('redis down'); } }),
        NOW,
      );
      assert.equal(frame.layers.conflicts, 'ok');
      assert.equal(frame.layers.earthquakes, 'ok');
      assert.equal(frame.layers.weather, 'unavailable');
      assert.deepEqual(frame.data.conflicts, [{ id: 'c1' }]);
      assert.equal(frame.data.weatherAlerts, undefined);
    });

    it('reports a two-source layer as partial when only one upstream answers', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes'],
        'free',
        sources({ listNaturalEvents: async () => { throw new Error('seed missing'); } }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'partial');
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.equal(frame.data.naturalEvents, undefined);
    });

    it('reports a two-source layer as unavailable only when both upstreams fail', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes'],
        'free',
        sources({
          listEarthquakes: async () => { throw new Error('down'); },
          listNaturalEvents: async () => { throw new Error('down'); },
        }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'unavailable');
      assert.deepEqual(frame.data, {});
    });

    it('still returns a well-formed frame when every upstream fails', async () => {
      const boom = async () => { throw new Error('everything is down'); };
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'earthquakes', 'weather'],
        'free',
        sources({
          listConflicts: boom,
          listEarthquakes: boom,
          listNaturalEvents: boom,
          listWeatherAlerts: boom,
        }),
        NOW,
      );
      assert.equal(frame.tier, 'free');
      assert.equal(frame.refreshMs, EMBED_FREE_REFRESH_MS);
      assert.deepEqual(frame.layers, {
        conflicts: 'unavailable',
        earthquakes: 'unavailable',
        weather: 'unavailable',
      });
      assert.deepEqual(frame.data, {});
    });
  });

  describe('shared-cache contract', () => {
    const url = (search: string) => `https://www.worldmonitor.app${EMBED_MAP_FRAME_PATH}${search}`;

    it('accepts the canonical free shape and returns its layers', () => {
      assert.deepEqual(
        classifyPublicEmbedFrameRequest(url('?layers=conflicts,earthquakes,weather&public=1')),
        ['conflicts', 'earthquakes', 'weather'],
      );
      assert.deepEqual(
        classifyPublicEmbedFrameRequest(url('?layers=conflicts&public=1')),
        ['conflicts'],
      );
    });

    it('bounds the shared key space to the free tier’s seven non-empty subsets', () => {
      const free = ['conflicts', 'earthquakes', 'weather'] as const;
      const accepted = new Set<string>();
      for (let mask = 1; mask < 8; mask++) {
        const subset = free.filter((_, i) => (mask >> i) & 1);
        const search = buildPublicEmbedFrameSearch(subset);
        assert.ok(classifyPublicEmbedFrameRequest(url(`?${search}`)), `${search} must be cacheable`);
        accepted.add(search);
      }
      assert.equal(accepted.size, 7);
    });

    it('rejects every near-miss rather than widening the key space', () => {
      const rejected = [
        // Reordered — a second spelling of the same set would double the entries.
        '?layers=weather,conflicts&public=1',
        // Parameter order swapped.
        '?public=1&layers=conflicts',
        // Percent-encoded separator: a re-serialised URLSearchParams compare
        // would normalise this into the accepted form.
        '?layers=conflicts%2Cweather&public=1',
        // Duplicated ids and duplicated params.
        '?layers=conflicts,conflicts&public=1',
        '?layers=conflicts&layers=weather&public=1',
        '?layers=conflicts&public=1&public=1',
        // A paid layer must never reach a shared entry.
        '?layers=conflicts,protests&public=1',
        '?layers=cables&public=1',
        // Extra, empty, and wrong-valued parameters.
        '?layers=conflicts&public=1&bbox=1,2,3,4',
        '?layers=&public=1',
        '?layers=conflicts&public=true',
        '?public=1',
        '?layers=conflicts',
        '',
        // The Vercel filesystem router's `?rpc=` echo does not reach this
        // static route, and if it ever did it must fail toward no-store.
        '?layers=conflicts&public=1&rpc=map-frame',
      ];
      for (const search of rejected) {
        assert.equal(
          classifyPublicEmbedFrameRequest(url(search)),
          null,
          `${search || '(no query)'} must not be shared-cacheable`,
        );
      }
    });

    it('refuses a non-GET method and a foreign path', () => {
      const good = '?layers=conflicts&public=1';
      assert.ok(classifyPublicEmbedFrameRequest(url(good), 'HEAD'));
      assert.equal(classifyPublicEmbedFrameRequest(url(good), 'POST'), null);
      assert.equal(
        classifyPublicEmbedFrameRequest(`https://www.worldmonitor.app/api/bootstrap${good}`),
        null,
      );
    });

    it('builds only URLs it will itself accept', () => {
      // Builder and validator are the pairing that keeps an emitted URL and a
      // cacheable URL from drifting apart.
      const search = buildPublicEmbedFrameSearch(['weather', 'conflicts']);
      assert.equal(search, 'layers=conflicts,weather&public=1');
      assert.deepEqual(classifyPublicEmbedFrameRequest(url(`?${search}`)), ['conflicts', 'weather']);
      assert.throws(() => buildPublicEmbedFrameSearch([]));
      assert.throws(() => buildPublicEmbedFrameSearch(['protests']));
    });

    it('canonicalises to registry order and drops duplicates', () => {
      assert.deepEqual(
        canonicalizeEmbedLayers(['weather', 'conflicts', 'weather', 'earthquakes']),
        ['conflicts', 'earthquakes', 'weather'],
      );
    });

    it('never lets a non-public response carry a shared-cacheable directive', () => {
      const keyed = cacheControlForEmbedFrame(false);
      assert.equal(keyed, 'private, no-store');
      for (const directive of ['public', 's-maxage', 'stale-while-revalidate', 'max-age=']) {
        assert.equal(
          keyed.includes(directive),
          false,
          `keyed Cache-Control must not contain ${directive}`,
        );
      }
    });

    it('gives the exact public shape a real shared lifetime', () => {
      const shared = cacheControlForEmbedFrame(true);
      assert.match(shared, /(^|[\s,])public([\s,]|$)/);
      assert.match(shared, new RegExp(`s-maxage=${Math.floor(EMBED_FREE_REFRESH_MS / 1000)}\\b`));
      assert.match(shared, /stale-while-revalidate=\d+/);
    });
  });

  describe('edge handler', () => {
    const source = readFileSync(resolve(__dirname, '../api/embed/map-frame.ts'), 'utf-8');

    it('classifies the shared shape from the URL before reading any credential', () => {
      // A CDN hit happens before the function sees a header, so the decision
      // that a body may be shared must not depend on one.
      const classifyIdx = source.indexOf('classifyPublicEmbedFrameRequest(req.url');
      // The call site, not the import line, which sorts above everything.
      const grantIdx = source.indexOf('deps.verifyGrant(grantFromHeaders');
      assert.ok(classifyIdx !== -1, 'the handler must classify the public shape');
      assert.ok(grantIdx !== -1, 'the handler must verify the grant');
      assert.ok(classifyIdx < grantIdx, 'classification must precede credential reading');
      assert.match(source, /claims\.panel === 'map'/);
    });

    it('derives Cache-Control from the shared classification, never from the tier', () => {
      // Tier and shareability are different questions: a keyless caller on a
      // near-miss URL is still `free`, and must still be uncacheable.
      assert.match(source, /cacheControlForEmbedFrame\(sharedLayers !== null\)/);
      assert.equal(source.includes("tier === 'keyed' ?"), false);
      assert.equal(source.includes('s-maxage'), false, 'the literal belongs in the shared helper');
    });

    it('varies on the grant only where the body actually depends on it', () => {
      assert.match(source, /if \(sharedLayers === null\) headers\.Vary = 'X-WorldMonitor-Grant'/);
    });

    it('accepts no knob other than layers', () => {
      for (const forbidden of ['sw_lat', 'ne_lat', 'bbox', 'page_size', 'pageSize:', 'start:', 'cursor:']) {
        const uses = source.split('\n').filter(
          (line) => line.includes(forbidden) && line.includes('searchParams'),
        );
        assert.deepEqual(uses, [], `${forbidden} must not be read from the request`);
      }
      // `public` is not read here at all — the shared classifier owns it, so
      // the handler's only direct query read is the layer list.
      const reads = [...source.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(reads)].sort(), ['layers']);
    });

    it('rate limits both keyless and keyed paths', () => {
      assert.match(source, /checkEndpointRateLimit/);
      assert.match(source, /principalUserId \? \{ principalUserId \} : \{\}/);
    });

    it('uses the verified account as the paid-frame rate-limit principal before source reads', async () => {
      const calls: string[] = [];
      let options: { principalUserId?: string } | undefined;
      const deps: EmbedMapFrameHandlerDeps = {
        getCorsHeaders: () => ({}),
        verifyGrant: async () => ({
          panel: 'map',
          accountId: 'user_partner',
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
        }),
        checkRateLimit: async (_req, _path, _cors, opts) => {
          calls.push('limit');
          options = opts;
          return new Response('', { status: 503, headers: { 'Retry-After': '60' } });
        },
        composeFrame: async () => {
          calls.push('compose');
          return composeEmbedMapFrame(['conflicts'], 'keyed', sources(), NOW);
        },
      };

      const response = await handleEmbedMapFrame(
        new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=conflicts', {
          headers: { 'X-WorldMonitor-Grant': 'wmg_test' },
        }),
        deps,
      );

      assert.equal(response.status, 503);
      assert.deepEqual(options, { principalUserId: 'user_partner' });
      assert.deepEqual(calls, ['limit']);
    });

    it('ignores an attached grant on the canonical public URL and keeps the IP budget', async () => {
      let grantReads = 0;
      let options: { principalUserId?: string } | undefined;
      const deps: EmbedMapFrameHandlerDeps = {
        getCorsHeaders: () => ({}),
        verifyGrant: async () => {
          grantReads += 1;
          return null;
        },
        checkRateLimit: async (_req, _path, _cors, opts) => {
          options = opts;
          return new Response('', { status: 429 });
        },
        composeFrame: async () => composeEmbedMapFrame(['conflicts'], 'free', sources(), NOW),
      };

      const response = await handleEmbedMapFrame(
        new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=conflicts&public=1', {
          headers: { 'X-WorldMonitor-Grant': 'wmg_attached' },
        }),
        deps,
      );

      assert.equal(response.status, 429);
      assert.equal(grantReads, 0);
      assert.deepEqual(options, {});
    });

    it('accepts only the grant, never a wm_ key or a viewer cookie', () => {
      assert.match(source, /X-WorldMonitor-Grant/);
      assert.equal(source.includes('validateUserApiKey'), false);
      assert.equal(source.includes('user-api-key'), false);
      assert.equal(source.includes('X-WorldMonitor-Key'), false);
      assert.equal(source.includes('getCookie'), false);
      assert.equal(source.includes("headers.get('cookie')"), false);
    });
  });
});

it('does not publicly cache partial or unavailable requested map layers', async () => {
  for (const state of ['partial', 'unavailable'] as const) {
    const response = await handleEmbedMapFrame(new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=weather&public=1'), {
      getCorsHeaders: () => ({}),
      verifyGrant: async () => null,
      checkRateLimit: async () => null,
      composeFrame: async () => ({ tier: 'free', refreshMs: 3600000, generatedAt: NOW, layers: { weather: state }, data: {} }),
    });
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  }
});
