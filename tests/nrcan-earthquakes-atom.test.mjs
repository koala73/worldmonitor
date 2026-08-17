import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EARTHQUAKES_MAX_CONTENT_AGE_MIN,
  EARTHQUAKES_WINDOW_MS,
  MAX_NRCAN_ATOM_BYTES,
  NRCAN_ATOM_HOST,
  NRCAN_ATOM_URL,
  NRCAN_ID_PREFIX,
  NrcanAtomParseError,
  USGS_MIN_MAGNITUDE,
  earthquakeIdentity,
  earthquakesAfterPublish,
  earthquakesContentMeta,
  fetchApprovedAtom,
  fetchMergedEarthquakes,
  isIndustryRelated,
  isPublishableEarthquake,
  mergeEarthquakeFeeds,
  nrcanAtomCacheKey,
  parseNrcanAtom,
  parseUsgsGeojson,
} from '../scripts/seismology/nrcan-atom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureXml = readFileSync(resolve(here, 'fixtures/seismology/nrcan-canada-en.atom'), 'utf8');
const parseModuleSrc = readFileSync(resolve(here, '../scripts/seismology/nrcan-atom.mjs'), 'utf8');
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');

const EMPTY_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Earthquakes in the last 30 days (Canada)</title>
  <updated>2026-08-13T21:20:06Z</updated>
</feed>
`;

const MERGE_NOW = Date.parse('2026-08-13T21:30:00Z');

function usgsEq(overrides = {}) {
  return {
    id: 'us7000test',
    place: '192 km SW of Port Hardy, BC',
    magnitude: 4.6,
    depthKm: 10,
    location: { latitude: 49.563, longitude: -129.4835 },
    occurredAt: Date.parse('2026-08-13T09:54:32Z'),
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',
    source: 'usgs',
    ...overrides,
  };
}

function nrcanEq(overrides = {}) {
  return {
    id: `${NRCAN_ID_PREFIX}20260813.0954001`,
    place: '192 km SW of Port Hardy, BC',
    magnitude: 4.61,
    depthKm: 10,
    location: { latitude: 49.563, longitude: -129.4835 },
    occurredAt: Date.parse('2026-08-13T09:54:32Z'),
    sourceUrl: 'https://www.earthquakescanada.nrcan.gc.ca/?eventid=20260813.0954001',
    source: 'nrcan',
    category: 'known earthquake',
    ...overrides,
  };
}

describe('nrcan atom fixture (live host capture)', () => {
  it('captures magnitude, depth, and coordinates from the working nrcan host', () => {
    const { earthquakes, feedUpdatedAt } = parseNrcanAtom(fixtureXml);
    assert.equal(earthquakes.length, 3);
    assert.equal(feedUpdatedAt, Date.parse('2026-08-13T21:20:06Z'));

    const industry = earthquakes.find((eq) => eq.id === `${NRCAN_ID_PREFIX}20260813.1111001`);
    assert.ok(industry);
    assert.equal(industry.source, 'nrcan');
    assert.equal(industry.category, 'suspected industry-related');
    assert.equal(industry.magnitude, 2.17);
    assert.equal(industry.depthKm, 1);
    assert.equal(industry.location.latitude, 56.2548);
    assert.equal(industry.location.longitude, -116.5788);
    assert.equal(industry.occurredAt, Date.parse('2026-08-13T11:11:27Z'));

    const offshore = earthquakes.find((eq) => eq.id === `${NRCAN_ID_PREFIX}20260813.0954001`);
    assert.equal(offshore.magnitude, 3.16);
    assert.equal(offshore.depthKm, 10);
    assert.equal(offshore.location.latitude, 49.563);
    assert.equal(offshore.location.longitude, -129.4835);

    const quebec = earthquakes.find((eq) => eq.id === `${NRCAN_ID_PREFIX}20260813.0639001`);
    assert.equal(quebec.magnitude, 0.04);
    assert.equal(quebec.depthKm, 15.05);
    assert.equal(quebec.location.latitude, 47.552);
    assert.equal(quebec.location.longitude, -70.2495);
  });

  it('does not use entry <updated> midnight as the origin time', () => {
    const { earthquakes } = parseNrcanAtom(fixtureXml);
    for (const eq of earthquakes) {
      assert.notEqual(eq.occurredAt, Date.parse('2026-08-13T00:00:00Z'));
    }
  });
});

describe('parse failure vs empty Atom', () => {
  it('treats a well-formed Atom document with zero entries as valid empty', () => {
    const parsed = parseNrcanAtom(EMPTY_ATOM);
    assert.deepEqual(parsed.earthquakes, []);
    assert.equal(parsed.feedUpdatedAt, Date.parse('2026-08-13T21:20:06Z'));
  });

  it('throws SEED_ERROR on parse failure', () => {
    assert.throws(() => parseNrcanAtom(''), NrcanAtomParseError);
    assert.throws(() => parseNrcanAtom('<html>403</html>'), (err) => err.code === 'SEED_ERROR');
    assert.throws(() => parseNrcanAtom('not xml at all'), (err) => err.name === 'NrcanAtomParseError');
    assert.throws(() => parseNrcanAtom('<rss><item>nope</item></rss>'), /not a well-formed feed/);
  });
});

describe('dedup identity', () => {
  it('dedups by namespaced id or time+mag+lat/lon bucket, not by place string', () => {
    const samePlaceDifferentQuakes = mergeEarthquakeFeeds(
      [usgsEq({ id: 'us-a', occurredAt: Date.parse('2026-08-13T09:54:32Z'), magnitude: 4.6 })],
      [nrcanEq({
        id: `${NRCAN_ID_PREFIX}nrcan-b`,
        place: '192 km SW of Port Hardy, BC',
        occurredAt: Date.parse('2026-08-13T12:00:00Z'),
        magnitude: 4.7,
        location: { latitude: 50.1, longitude: -128.0 },
      })],
      MERGE_NOW,
    );
    assert.equal(samePlaceDifferentQuakes.length, 2, 'unique place string is not identity');

    const sameBucketDifferentPlace = mergeEarthquakeFeeds(
      [usgsEq({ id: 'us7000abcd', place: 'USGS wording' })],
      [nrcanEq({ id: `${NRCAN_ID_PREFIX}20260813.0954001`, place: 'NRCan wording' })],
      MERGE_NOW,
    );
    assert.equal(sameBucketDifferentPlace.length, 1, 'cross-agency bucket match keeps USGS');
    assert.equal(sameBucketDifferentPlace[0].source, 'usgs');
    assert.equal(sameBucketDifferentPlace[0].id, 'us7000abcd');

    const namespacedIdsDoNotCollide = mergeEarthquakeFeeds(
      [usgsEq({ id: '20260813.0954001', magnitude: 5.1, location: { latitude: 10, longitude: 20 }, occurredAt: Date.parse('2026-08-13T01:00:00Z') })],
      [nrcanEq({ id: `${NRCAN_ID_PREFIX}20260813.0954001`, magnitude: 5.2, location: { latitude: 40, longitude: -80 }, occurredAt: Date.parse('2026-08-13T08:00:00Z') })],
      MERGE_NOW,
    );
    assert.equal(namespacedIdsDoNotCollide.length, 2, 'raw NRCan eventid must not collide with a USGS id');
  });

  it('does not treat a unique name/place string as identity', () => {
    const a = nrcanEq({ id: `${NRCAN_ID_PREFIX}one`, place: 'unique place name' });
    const b = nrcanEq({
      id: `${NRCAN_ID_PREFIX}two`,
      place: 'unique place name',
      occurredAt: Date.parse('2026-08-12T00:00:00Z'),
      magnitude: 4.8,
      location: { latitude: 60, longitude: -130 },
    });
    assert.notEqual(earthquakeIdentity(a), earthquakeIdentity(b));
    assert.equal(mergeEarthquakeFeeds([], [a, b], MERGE_NOW).length, 2);
  });

  it('matches cross-agency events across old rounding boundaries with inclusive tolerances', () => {
    const usgs = usgsEq({
      id: 'us-boundary',
      occurredAt: Date.parse('2026-08-13T09:54:29Z'),
      magnitude: 4.54,
      location: { latitude: 49.524, longitude: -129.4835 },
    });
    const nrcan = nrcanEq({
      id: `${NRCAN_ID_PREFIX}boundary`,
      occurredAt: Date.parse('2026-08-13T09:54:31Z'),
      magnitude: 4.56,
      location: { latitude: 49.526, longitude: -129.4835 },
    });

    assert.deepEqual(mergeEarthquakeFeeds([usgs], [nrcan], MERGE_NOW).map((eq) => eq.id), ['us-boundary']);
  });

  it('retains cross-agency events just outside time, magnitude, or distance tolerance', () => {
    const base = usgsEq({ id: 'us-base', occurredAt: MERGE_NOW - 120_000, magnitude: 4.6, location: { latitude: 0, longitude: 0 } });
    const cases = [
      nrcanEq({ id: `${NRCAN_ID_PREFIX}time`, occurredAt: base.occurredAt + 60_001, magnitude: 4.6, location: { latitude: 0, longitude: 0 } }),
      nrcanEq({ id: `${NRCAN_ID_PREFIX}magnitude`, occurredAt: base.occurredAt, magnitude: 4.700_001, location: { latitude: 0, longitude: 0 } }),
      nrcanEq({ id: `${NRCAN_ID_PREFIX}distance`, occurredAt: base.occurredAt, magnitude: 4.6, location: { latitude: 0, longitude: 0.09 } }),
    ];

    for (const candidate of cases) {
      assert.equal(mergeEarthquakeFeeds([base], [candidate], MERGE_NOW).length, 2, candidate.id);
    }
  });

  it('treats the 60-second, 0.1-magnitude, and 10-kilometre limits as inclusive', () => {
    const longitudeAtTenKm = (10 / 6371.0088) * (180 / Math.PI);
    const usgs = usgsEq({
      id: 'us-inclusive',
      occurredAt: MERGE_NOW - 120_000,
      magnitude: 4.6,
      location: { latitude: 0, longitude: 0 },
    });
    const nrcan = nrcanEq({
      id: `${NRCAN_ID_PREFIX}inclusive`,
      occurredAt: usgs.occurredAt + 60_000,
      magnitude: 4.7,
      location: { latitude: 0, longitude: longitudeAtTenKm },
    });

    assert.deepEqual(mergeEarthquakeFeeds([usgs], [nrcan], MERGE_NOW).map((eq) => eq.id), ['us-inclusive']);
  });

  it('does not tolerance-dedup same-agency or ambiguous cross-agency swarms', () => {
    const usgsA = usgsEq({ id: 'us-a' });
    const usgsB = usgsEq({ id: 'us-b', occurredAt: usgsA.occurredAt + 1_000 });
    assert.equal(mergeEarthquakeFeeds([usgsA, usgsB], [], MERGE_NOW).length, 2);

    const nrcanA = nrcanEq({ id: `${NRCAN_ID_PREFIX}a` });
    const nrcanB = nrcanEq({ id: `${NRCAN_ID_PREFIX}b`, occurredAt: nrcanA.occurredAt + 1_000 });
    const expected = ['us-a', `${NRCAN_ID_PREFIX}b`, `${NRCAN_ID_PREFIX}a`];
    assert.deepEqual(mergeEarthquakeFeeds([usgsA], [nrcanA, nrcanB], MERGE_NOW).map((eq) => eq.id), expected);
    assert.deepEqual(mergeEarthquakeFeeds([usgsA], [nrcanB, nrcanA], MERGE_NOW).map((eq) => eq.id), expected);
  });
});

describe('publish filter: industry-related + M4.5 week window', () => {
  it('keeps category on the parsed record but does not publish M0.04 or industry-related', () => {
    const { earthquakes } = parseNrcanAtom(fixtureXml);
    const quebec = earthquakes.find((eq) => eq.id === `${NRCAN_ID_PREFIX}20260813.0639001`);
    const industry = earthquakes.find((eq) => eq.id === `${NRCAN_ID_PREFIX}20260813.1111001`);
    assert.equal(quebec.magnitude, 0.04);
    assert.equal(quebec.category, 'known earthquake');
    assert.equal(industry.category, 'suspected industry-related');
    assert.equal(isIndustryRelated(industry), true);
    assert.equal(isPublishableEarthquake(quebec, MERGE_NOW), false);
    assert.equal(isPublishableEarthquake(industry, MERGE_NOW), false);
    assert.equal(USGS_MIN_MAGNITUDE, 4.5);
    assert.equal(EARTHQUAKES_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);

    const published = mergeEarthquakeFeeds([], earthquakes, MERGE_NOW);
    assert.equal(published.length, 0, 'fixture M0.04 / M2.17 industry / M3.16 must not enter the global M4.5 week layer');
  });

  it('drops a live-shaped M0.04 and an industry-related M4.6 across merge', () => {
    const micro = nrcanEq({
      id: `${NRCAN_ID_PREFIX}micro`,
      magnitude: 0.04,
      place: '13 km SW of La Malbaie, QC',
      category: 'known earthquake',
    });
    const blast = nrcanEq({
      id: `${NRCAN_ID_PREFIX}blast`,
      magnitude: 4.8,
      place: 'Suspected industry-related event, 27 km S of Woodland Cree 226, AB',
      category: 'suspected industry-related',
    });
    const stale = nrcanEq({
      id: `${NRCAN_ID_PREFIX}stale`,
      magnitude: 5.1,
      occurredAt: Date.parse('2026-07-20T00:00:00Z'),
      category: 'known earthquake',
    });
    const keep = nrcanEq({
      id: `${NRCAN_ID_PREFIX}keep`,
      magnitude: 4.7,
      location: { latitude: 48.2, longitude: -123.1 },
      occurredAt: Date.parse('2026-08-12T18:00:00Z'),
    });
    const published = mergeEarthquakeFeeds([usgsEq()], [micro, blast, stale, keep], MERGE_NOW);
    assert.deepEqual(published.map((eq) => eq.id), ['us7000test', `${NRCAN_ID_PREFIX}keep`]);
  });
});

describe('independent upstreams and content-age min()', () => {
  it('publishes NRCan when USGS fails, and USGS when NRCan fails', async () => {
    const nrcanOnly = await fetchMergedEarthquakes({
      fetchUsgs: async () => { throw new Error('USGS down'); },
      fetchNrcan: async () => ({ earthquakes: [nrcanEq()], newestAt: 100, oldestAt: 50 }),
      nowMs: MERGE_NOW,
    });
    assert.equal(nrcanOnly.earthquakes.length, 1);
    assert.equal(nrcanOnly.earthquakes[0].source, 'nrcan');
    assert.equal(nrcanOnly._usgsNewestAt, null);
    assert.equal(nrcanOnly._nrcanNewestAt, 100);

    const usgsOnly = await fetchMergedEarthquakes({
      fetchUsgs: async () => ({ earthquakes: [usgsEq()], newestAt: 200, oldestAt: 20 }),
      fetchNrcan: async () => { throw new NrcanAtomParseError('bad atom'); },
      nowMs: MERGE_NOW,
    });
    assert.equal(usgsOnly.earthquakes.length, 1);
    assert.equal(usgsOnly.earthquakes[0].source, 'usgs');
    assert.equal(usgsOnly._nrcanNewestAt, null);

    // Publishing the survivor is correct; reporting it as a COMPLETE result is
    // not. Each single-upstream result must name the upstream it lost.
    assert.deepEqual(nrcanOnly._failedSources, ['usgs']);
    assert.deepEqual(usgsOnly._failedSources, ['nrcan']);
    assert.match(usgsOnly._failureDetail, /nrcan: .*bad atom/);
  });

  it('reports no failed sources when both upstreams answer', () => {
    // The negative case: without it _failedSources could be hardcoded non-empty
    // and every assertion above would still pass.
    return fetchMergedEarthquakes({
      fetchUsgs: async () => ({ earthquakes: [usgsEq()], newestAt: 200, oldestAt: 20 }),
      fetchNrcan: async () => ({ earthquakes: [nrcanEq()], newestAt: 100, oldestAt: 50 }),
      nowMs: MERGE_NOW,
    }).then((both) => {
      assert.deepEqual(both._failedSources, []);
      assert.equal(both._failureDetail, '');
    });
  });

  it('degrades seed-meta when an upstream is missing, because content-age cannot', async () => {
    // THE BUG THIS CLOSES. earthquakesContentMeta takes min() over the upstreams
    // that answered, so a FROZEN NRCan is caught but a FAILED one is not: its
    // null is filtered out and USGS's fresh timestamp survives as the minimum.
    // Both gates therefore pass while every Canadian event is missing.
    const usgsOnly = await fetchMergedEarthquakes({
      fetchUsgs: async () => ({ earthquakes: [usgsEq()], newestAt: MERGE_NOW, oldestAt: MERGE_NOW - 1000 }),
      fetchNrcan: async () => { throw new Error('NRCan 503'); },
      nowMs: MERGE_NOW,
    });

    // Content-age still looks perfectly fresh — this is the hole, asserted.
    const meta = earthquakesContentMeta(usgsOnly, MERGE_NOW);
    assert.equal(meta.newestItemAt, MERGE_NOW, 'a failed upstream leaves content-age fresh');

    // So the degradation has to come from somewhere else: the afterPublish patch.
    const patch = earthquakesAfterPublish(usgsOnly);
    assert.equal(patch.freshnessMetaPatch.sourceState, 'degraded');
    assert.equal(patch.freshnessMetaPatch.errorCode, 'EARTHQUAKE_UPSTREAM_INCOMPLETE');
    assert.match(patch.freshnessMetaPatch.skipReason, /nrcan/);

    // And a complete run must NOT be patched, or every run reads degraded and
    // the signal is worthless.
    const both = await fetchMergedEarthquakes({
      fetchUsgs: async () => ({ earthquakes: [usgsEq()], newestAt: MERGE_NOW, oldestAt: 20 }),
      fetchNrcan: async () => ({ earthquakes: [nrcanEq()], newestAt: MERGE_NOW, oldestAt: 50 }),
      nowMs: MERGE_NOW,
    });
    assert.equal(earthquakesAfterPublish(both), undefined);
  });

  it('wires afterPublish into runSeed, or the patch never reaches seed-meta', () => {
    // runSeed writes seed-meta itself and merges only afterPublish's
    // freshnessMetaPatch. A hook that exists but is not registered is inert.
    const seeder = readFileSync(new URL('../scripts/seed-earthquakes.mjs', import.meta.url), 'utf8');
    assert.match(seeder, /afterPublish:\s*earthquakesAfterPublish/);
  });

  it('throws when every upstream fails', async () => {
    await assert.rejects(
      fetchMergedEarthquakes({
        fetchUsgs: async () => { throw new Error('USGS down'); },
        fetchNrcan: async () => { throw new NrcanAtomParseError('bad atom'); },
      }),
      /All earthquake upstreams failed/,
    );
  });

  it('uses min() of successful upstream newest timestamps so USGS cannot hide an NRCan freeze', () => {
    const now = Date.parse('2026-08-13T21:30:00Z');
    const meta = earthquakesContentMeta({
      _usgsNewestAt: Date.parse('2026-08-13T21:00:00Z'),
      _nrcanNewestAt: Date.parse('2026-08-10T00:00:00Z'),
      _usgsOldestAt: Date.parse('2026-08-07T00:00:00Z'),
      _nrcanOldestAt: Date.parse('2026-08-01T00:00:00Z'),
    }, now);
    assert.equal(meta.newestItemAt, Date.parse('2026-08-10T00:00:00Z'));
    assert.equal(meta.oldestItemAt, Date.parse('2026-08-01T00:00:00Z'));
  });

  it('omits a failed upstream from content-age instead of substituting Date.now()', () => {
    const now = Date.parse('2026-08-13T21:30:00Z');
    const meta = earthquakesContentMeta({
      _usgsNewestAt: Date.parse('2026-08-13T21:00:00Z'),
      _nrcanNewestAt: null,
      _usgsOldestAt: Date.parse('2026-08-07T00:00:00Z'),
      _nrcanOldestAt: null,
    }, now);
    assert.equal(meta.newestItemAt, Date.parse('2026-08-13T21:00:00Z'));
    assert.notEqual(meta.newestItemAt, now);
  });

  it('does not Date.now() missing entry dates', () => {
    assert.doesNotMatch(parseModuleSrc, /occurredAt[^\n]*Date\.now\(\)/);
    const parsed = parseNrcanAtom(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <updated>2026-08-13T21:20:06Z</updated>
      <entry>
        <title>No timestamp here M2.0 somewhere</title>
        <id>https://www.earthquakescanada.nrcan.gc.ca/?eventid=nodate</id>
        <georss:point>50 -120</georss:point>
        <georss:elev>-5000</georss:elev>
      </entry>
    </feed>`);
    assert.equal(parsed.earthquakes.length, 0);
  });
});

describe('approved NRCan transport', () => {
  it('allowlist rejects the canada.ca host', async () => {
    await assert.rejects(
      fetchApprovedAtom('https://www.canada.ca/en/natural-resources/services/earthquakes.atom', {
        allowedHosts: [NRCAN_ATOM_HOST],
      }),
      /UNTRUSTED_SOURCE_HOST/,
    );
  });

  it('pins www.earthquakescanada.nrcan.gc.ca, rejects redirects, caps bytes, and keys cache by Atom URL', async () => {
    assert.ok(MAX_NRCAN_ATOM_BYTES >= 343771);
    assert.equal(NRCAN_ATOM_URL, 'https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-en.atom');
    assert.ok(nrcanAtomCacheKey(NRCAN_ATOM_URL).includes(NRCAN_ATOM_URL));
    assert.ok(EARTHQUAKES_MAX_CONTENT_AGE_MIN > 0);

    let init;
    const cache = new Map();
    const xml = await fetchApprovedAtom(NRCAN_ATOM_URL, {
      allowedHosts: [NRCAN_ATOM_HOST],
      fetchFn: async (_url, options) => {
        init = options;
        return new Response(EMPTY_ATOM, { headers: { 'content-type': 'application/atom+xml' } });
      },
      cache,
    });
    assert.equal(init.redirect, 'error');
    assert.match(init.headers['User-Agent'], /Chrome/);
    assert.equal(xml, EMPTY_ATOM);
    assert.ok(cache.has(nrcanAtomCacheKey(NRCAN_ATOM_URL)));

    await assert.rejects(
      fetchApprovedAtom(NRCAN_ATOM_URL, {
        allowedHosts: [NRCAN_ATOM_HOST],
        maxBytes: 10,
        fetchFn: async () => new Response(EMPTY_ATOM),
      }),
      /RESPONSE_TOO_LARGE/,
    );
  });

  it('does not bind fetch or target canada.ca in production code', () => {
    assert.doesNotMatch(parseModuleSrc, /fetch\.bind/);
    assert.doesNotMatch(parseModuleSrc, /www\.canada\.ca/);
    assert.doesNotMatch(parseModuleSrc, /fetch\.bind\(globalThis\)/);
  });
});

describe('proto source/category fields (P1)', () => {
  it('declares source=12 and category=13 so NRCan is not labeled USGS on proto/SDK/OpenAPI', () => {
    const proto = readFileSync(resolve(here, '../proto/worldmonitor/seismology/v1/earthquake.proto'), 'utf8');
    assert.match(proto, /string source = 12;/);
    assert.match(proto, /string category = 13;/);

    const client = readFileSync(resolve(here, '../src/generated/client/worldmonitor/seismology/v1/service_client.ts'), 'utf8');
    assert.match(client, /export interface Earthquake \{[\s\S]*\bsource: string;/);
    assert.match(client, /export interface Earthquake \{[\s\S]*\bcategory: string;/);

    const openapi = readFileSync(resolve(here, '../docs/api/SeismologyService.openapi.yaml'), 'utf8');
    const eqBlock = openapi.split('        Earthquake:')[1]?.split('        GeoCoordinates:')[0] || '';
    assert.match(eqBlock, /^\s+source:/m);
    assert.match(eqBlock, /^\s+category:/m);
    assert.match(eqBlock, /"usgs"/);
    assert.match(eqBlock, /"nrcan"/);
  });

  it('proto-shaped JSON round-trip keeps source: nrcan so MapPopup does not label USGS', () => {
    const eq = nrcanEq();
    const protoFields = [
      'id', 'place', 'magnitude', 'depthKm', 'location', 'occurredAt',
      'sourceUrl', 'nearTestSite', 'testSiteName', 'concernScore', 'concernLevel',
      'source', 'category',
    ];
    const encoded = Object.fromEntries(protoFields.filter((k) => eq[k] !== undefined).map((k) => [k, eq[k]]));
    const decoded = JSON.parse(JSON.stringify(encoded));
    assert.equal(decoded.source, 'nrcan');
    assert.equal(decoded.category, 'known earthquake');
    assert.equal(decoded.id.startsWith('nrcan:'), true);
    const sourceName = decoded.source === 'nrcan' ? 'Earthquakes Canada' : 'USGS';
    assert.equal(sourceName, 'Earthquakes Canada');
  });

  it('resticks MCP-Apps / stats so the natural-disasters shell is not USGS-only', () => {
    const registry = readFileSync(resolve(here, '../api/mcp/ui/registry.ts'), 'utf8');
    assert.match(registry, /Earthquakes Canada \/ NRCan/);
    assert.doesNotMatch(registry, /groups recent earthquakes \(USGS magnitude, place, time\)/);

    const stats = readFileSync(resolve(here, '../docs/generated/stats.json'), 'utf8');
    assert.match(stats, /Earthquakes Canada \/ NRCan/);
    assert.doesNotMatch(stats, /groups recent earthquakes \(USGS magnitude, place, time\)/);
  });
});

describe('module import contract', () => {
  it('tests import the parse module, not the seeder', () => {
    assert.doesNotMatch(testSrc, /from ['"][^'"]*seed-earthquakes/);
    assert.doesNotMatch(parseModuleSrc, /from ['"][^'"]*seed-earthquakes/);
  });

  it('seeder does not bind fetch or fetch the canada.ca Atom', () => {
    const seederSrc = readFileSync(resolve(here, '../scripts/seed-earthquakes.mjs'), 'utf8');
    assert.doesNotMatch(seederSrc, /fetch\.bind/);
    assert.doesNotMatch(seederSrc, /www\.canada\.ca/);
    assert.match(seederSrc, /NRCAN_ATOM_URL/);
  });

  it('parses USGS geojson with source tags', () => {
    const parsed = parseUsgsGeojson({
      metadata: { generated: 1_700_000_000_000 },
      features: [{
        id: 'us1',
        properties: { place: 'somewhere', mag: 5.1, time: 1_700_000_000_000, url: 'https://earthquake.usgs.gov/1' },
        geometry: { coordinates: [-120, 40, 12] },
      }],
    });
    assert.equal(parsed.earthquakes[0].source, 'usgs');
    assert.equal(parsed.earthquakes[0].depthKm, 12);
    assert.equal(parsed.newestAt, 1_700_000_000_000);
  });
});
