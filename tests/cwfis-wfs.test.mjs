import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME_UA } from '../scripts/_seed-utils.mjs';
import { __testing__ as healthTesting } from '../api/health.js';
import {
  CWFIS_ACTIVE_LAYER,
  CWFIS_FETCH_TIMEOUT_MS,
  CWFIS_MAX_PAGES,
  CWFIS_PAGE_SIZE,
  CWFIS_ALLOWED_LAYERS,
  CWFIS_PRESCRIBED_LAYER,
  CWFIS_WFS_BASE,
  CWFIS_WFS_HOST,
  CWFIS_ARCHIVE_MATCHED_REFUSAL,
  MAX_CWFIS_RESPONSE_BYTES,
  assertNotCwfisArchive,
  buildCwfisGetFeatureUrl,
  currentValidCql,
  cwfisWildfireAfterPublish,
  cwfisWfsCacheKey,
  fetchApprovedWfs,
  fetchCwfisLayer,
  fetchCwfisFires,
  isEmergencyPagingCandidate,
  mergeWildfireSources,
  parseCwfisGeoJson,
  parseCwfisGml,
  resolveCwfisCqlFilter,
  stableCwfisFireId,
} from '../scripts/wildfire/cwfis-wfs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const activeJson = readFileSync(resolve(here, 'fixtures/wildfire/cwfis-national-activefires.json'), 'utf8');
const prescribedJson = readFileSync(resolve(here, 'fixtures/wildfire/cwfis-national-prescribedfires.json'), 'utf8');
const activeGml = readFileSync(resolve(here, 'fixtures/wildfire/cwfis-national-activefires.gml'), 'utf8');
const parseModuleSrc = readFileSync(resolve(here, '../scripts/wildfire/cwfis-wfs.mjs'), 'utf8');
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const seederSrc = readFileSync(resolve(here, '../scripts/seed-fire-detections.mjs'), 'utf8');
const thermalSrc = readFileSync(resolve(here, '../scripts/lib/thermal-escalation.mjs'), 'utf8');
const aisRelaySrc = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');

function firmsDetection(overrides = {}) {
  return {
    id: '49.000-30.000-2026-08-13-1130',
    location: { latitude: 49, longitude: 30 },
    brightness: 340,
    frp: 12,
    confidence: 'FIRE_CONFIDENCE_NOMINAL',
    satellite: 'VIIRS_SNPP_NRT',
    detectedAt: Date.parse('2026-08-13T11:30:00Z'),
    region: 'Ukraine',
    dayNight: 'D',
    possibleExplosion: false,
    source: 'firms',
    kind: 'active',
    emergency: true,
    ...overrides,
  };
}

describe('cwfis live fixture coordinates and ids', () => {
  it('parses WGS84 lat/lon from live GetFeature JSON, not EPSG:3978 geometry', () => {
    const parsed = parseCwfisGeoJson(activeJson, 'active');
    assert.equal(parsed.fireDetections.length, 2);

    const lytton = parsed.fireDetections.find((f) => f.nationalFireId === '2026_BC_2026-V10742');
    assert.ok(lytton);
    assert.equal(lytton.source, 'cwfis');
    assert.equal(lytton.kind, 'active');
    assert.equal(lytton.emergency, true);
    assert.equal(lytton.location.latitude, 49.89345);
    assert.equal(lytton.location.longitude, -121.45475);
    assert.notEqual(lytton.location.latitude, -1840333.9025);
    assert.equal(lytton.id, 'cwfis:2026_BC_2026-V10742');
    assert.ok(lytton.id.length <= 100);
    assert.equal(lytton.region, 'British Columbia');
    assert.equal(lytton.possibleExplosion, false);
    assert.equal(isEmergencyPagingCandidate(lytton), true);

    const cariboo = parsed.fireDetections.find((f) => f.nationalFireId === '2026_BC_2026-C41588');
    assert.equal(cariboo.location.latitude, 51.51885);
    assert.equal(cariboo.location.longitude, -121.87068);
  });

  it('labels prescribed burns as not-emergency from the live prescribed layer', () => {
    const parsed = parseCwfisGeoJson(prescribedJson, 'prescribed');
    assert.equal(parsed.fireDetections.length, 2);
    for (const fire of parsed.fireDetections) {
      assert.equal(fire.kind, 'prescribed');
      assert.equal(fire.emergency, false);
      assert.equal(fire.source, 'cwfis');
      assert.equal(fire.possibleExplosion, false);
      assert.equal(isEmergencyPagingCandidate(fire), false);
      assert.match(fire.id, /^cwfis:prescribed:/);
    }
    const jasper = parsed.fireDetections.find((f) => f.nationalFireId === '2026_PC_2026JA2');
    assert.equal(jasper.location.latitude, 52.8813);
    assert.equal(jasper.location.longitude, -118.1002);
    assert.equal(jasper.region, 'Parks Canada');
  });

  it('parses the same live coordinates from GML fallback', () => {
    const parsed = parseCwfisGml(activeGml, 'active');
    assert.equal(parsed.fireDetections.length, 1);
    const fire = parsed.fireDetections[0];
    assert.equal(fire.nationalFireId, '2026_BC_2026-V10742');
    assert.equal(fire.location.latitude, 49.89345);
    assert.equal(fire.location.longitude, -121.45475);
    assert.equal(fire.id, 'cwfis:2026_BC_2026-V10742');
  });

  it('joins only on cwfis:${national_fire_id}; missing nid is not a join key', () => {
    assert.equal(stableCwfisFireId({ national_fire_id: '2026_BC_2026-V10742' }), 'cwfis:2026_BC_2026-V10742');
    assert.equal(stableCwfisFireId({
      id: 20824134,
      latitude: 49.89345,
      longitude: -121.45475,
      status_date: '2026-08-13T11:30:00Z',
    }), '');
    assert.equal(stableCwfisFireId({ national_fire_id: '   ' }), '');
    assert.equal(stableCwfisFireId({}), '');
    assert.equal(
      parseCwfisGeoJson({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {
            latitude: 49.89345,
            longitude: -121.45475,
            agency_code: 'BC',
            status_date: '2026-08-13T11:30:00Z',
          },
        }],
      }, 'active').fireDetections.length,
      0,
    );
  });

  it('duplicate national_fire_id collapses to one join key', () => {
    const nid = '2026_BC_2026-V10742';
    assert.equal(stableCwfisFireId({ national_fire_id: nid }), stableCwfisFireId({ national_fire_id: nid }));
    const parsed = parseCwfisGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { national_fire_id: nid, latitude: 49.89, longitude: -121.45, agency_code: 'BC' } },
        { type: 'Feature', properties: { national_fire_id: nid, latitude: 49.90, longitude: -121.46, agency_code: 'BC' } },
      ],
    }, 'active');
    assert.equal(parsed.fireDetections.length, 2);
    assert.equal(parsed.fireDetections[0].id, parsed.fireDetections[1].id);
  });
});

describe('pagination and cache key', () => {
  it('includes typeName and startIndex in the cache key, and optional bbox', () => {
    const key = cwfisWfsCacheKey({
      typeName: CWFIS_ACTIVE_LAYER,
      bbox: '-141,41,-52,84',
      startIndex: 1000,
    });
    assert.match(key, /public:cwfif_national_activefires/);
    assert.match(key, /startIndex=1000/);
    assert.match(key, /bbox=-141,41,-52,84/);
    assert.notEqual(
      cwfisWfsCacheKey({ typeName: CWFIS_ACTIVE_LAYER, startIndex: 0 }),
      cwfisWfsCacheKey({ typeName: CWFIS_PRESCRIBED_LAYER, startIndex: 0 }),
    );
    assert.notEqual(
      cwfisWfsCacheKey({ typeName: CWFIS_ACTIVE_LAYER, startIndex: 0 }),
      cwfisWfsCacheKey({ typeName: CWFIS_ACTIVE_LAYER, startIndex: 1000 }),
    );
  });

  it('fails closed when maxPages is exhausted before numberMatched is complete', async () => {
    const requests = [];
    const page0 = {
      type: 'FeatureCollection',
      features: JSON.parse(activeJson).features.slice(0, 1),
      numberMatched: 3,
      numberReturned: 1,
      links: [{
        rel: 'next',
        href: 'https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:cwfif_national_activefires&count=1&startIndex=1&sortBy=id&outputFormat=application/json',
      }],
    };
    const page1 = {
      type: 'FeatureCollection',
      features: JSON.parse(activeJson).features.slice(1, 2),
      numberMatched: 3,
      numberReturned: 1,
      links: [],
    };

    await assert.rejects(
      fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
        kind: 'active',
        pageSize: 1,
        maxPages: 2,
        cqlFilter: '',
        fetchFn: async (url) => {
          requests.push(url);
          const parsed = new URL(url);
          const start = Number(parsed.searchParams.get('startIndex') || 0);
          const body = start === 0 ? page0 : page1;
          return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        },
      }),
      /pagination incomplete.*2 of 3/i,
    );

    assert.ok(requests.length >= 2);
    assert.match(requests[0], /startIndex=0/);
    assert.match(requests[0], /count=1/);
    assert.match(requests[0], /sortBy=id/);
    assert.ok(CWFIS_MAX_PAGES >= 2);
    assert.ok(CWFIS_PAGE_SIZE >= 1);
    assert.ok(requests.length <= CWFIS_MAX_PAGES);
  });

  it('returns only after numberMatched proves pagination complete', async () => {
    const features = JSON.parse(activeJson).features;
    const result = await fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
      kind: 'active',
      pageSize: 1,
      maxPages: 2,
      cqlFilter: '',
      fetchFn: async (url) => {
        const start = Number(new URL(url).searchParams.get('startIndex') || 0);
        return new Response(JSON.stringify({
          type: 'FeatureCollection',
          features: features.slice(start, start + 1),
          numberMatched: 2,
          numberReturned: 1,
          links: start === 0 ? [{
            rel: 'next',
            href: 'https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:cwfif_national_activefires&count=1&startIndex=1&sortBy=id&outputFormat=application/json',
          }] : [],
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(result.fireDetections.length, 2);
  });

  it('rejects repeated pages even when requested offsets reach numberMatched', async () => {
    const repeatedFeature = JSON.parse(activeJson).features.slice(0, 1);
    await assert.rejects(
      fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
        kind: 'active',
        pageSize: 1,
        maxPages: 2,
        cqlFilter: '',
        fetchFn: async () => new Response(JSON.stringify({
          type: 'FeatureCollection',
          features: repeatedFeature,
          numberMatched: 2,
          numberReturned: 1,
          links: [],
        }), { headers: { 'content-type': 'application/json' } }),
      }),
      /pagination repeated a page/i,
    );
  });

  it('rejects numberReturned that does not match the received WFS rows', () => {
    assert.throws(
      () => parseCwfisGeoJson({
        type: 'FeatureCollection',
        features: JSON.parse(activeJson).features.slice(0, 1),
        numberMatched: 2,
        numberReturned: 2,
      }),
      /numberReturned mismatch: declared 2, received 1/i,
    );
    assert.throws(
      () => parseCwfisGml(activeGml.replace('numberReturned="1"', 'numberReturned="2"')),
      /numberReturned mismatch: declared 2, received 1/i,
    );
  });

  it('rejects a next link that does not advance startIndex', async () => {
    await assert.rejects(
      fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
        kind: 'active',
        pageSize: 1,
        maxPages: 2,
        cqlFilter: '',
        fetchFn: async () => new Response(JSON.stringify({
          type: 'FeatureCollection',
          features: JSON.parse(activeJson).features.slice(0, 1),
          numberMatched: 2,
          numberReturned: 1,
          links: [{
            rel: 'next',
            href: 'https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:cwfif_national_activefires&count=1&startIndex=0&sortBy=id&outputFormat=application/json',
          }],
        }), { headers: { 'content-type': 'application/json' } }),
      }),
      /did not advance/i,
    );
  });

  it('falls back to GML when JSON returns 400', async () => {
    let jsonAttempted = false;
    const result = await fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
      kind: 'active',
      cqlFilter: '',
      pageSize: 1,
      maxPages: 1,
      fetchFn: async (url, init) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('outputFormat') === 'application/json') {
          jsonAttempted = true;
          return new Response('<ows:ExceptionReport/>', { status: 400, headers: { 'content-type': 'application/xml' } });
        }
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers['User-Agent'], CHROME_UA);
        return new Response(
          activeGml.replace('numberMatched="584"', 'numberMatched="1"'),
          { headers: { 'content-type': 'application/gml+xml; version=3.2' } },
        );
      },
    });
    assert.equal(jsonAttempted, true);
    assert.equal(result.fireDetections[0].location.latitude, 49.89345);
  });
});

describe('host allowlist and transport', () => {
  it('rejects the old CWFIS host and public:activefires_current', async () => {
    await assert.rejects(
      fetchApprovedWfs('https://cwfis.cfs.nrcan.gc.ca/geoserver/ows?service=WFS&typeNames=public:cwfif_national_activefires'),
      /UNTRUSTED_SOURCE_HOST/,
    );
    assert.throws(
      () => buildCwfisGetFeatureUrl({ typeName: 'public:activefires_current' }),
      /not allowed/,
    );
    assert.throws(
      () => cwfisWfsCacheKey({ typeName: 'public:activefires_current', startIndex: 0 }),
      /not allowed/,
    );
    assert.equal(CWFIS_WFS_HOST, 'geoserver.cwfif.nrcan.gc.ca');
    assert.match(CWFIS_WFS_BASE, /geoserver\.cwfif\.nrcan\.gc\.ca/);
    assert.doesNotMatch(CWFIS_WFS_BASE, /cwfis\.cfs\.nrcan\.gc\.ca/);
    assert.equal(CWFIS_ALLOWED_LAYERS.includes('public:activefires_current'), false);
    assert.deepEqual([...CWFIS_ALLOWED_LAYERS], [
      'public:cwfif_national_activefires',
      'public:cwfif_national_prescribedfires',
      'public:cwfif_national_reportedfires',
    ]);
  });

  it('pins geoserver.cwfif.nrcan.gc.ca, rejects redirects, caps bytes, sends CHROME_UA', async () => {
    assert.equal(CWFIS_WFS_HOST, 'geoserver.cwfif.nrcan.gc.ca');
    assert.ok(MAX_CWFIS_RESPONSE_BYTES >= 7_377_447);
    assert.ok(CWFIS_FETCH_TIMEOUT_MS >= 15_000);

    let init;
    const cache = new Map();
    const url = buildCwfisGetFeatureUrl({ typeName: CWFIS_ACTIVE_LAYER, startIndex: 0, count: 1, cqlFilter: '' });
    const page = await fetchApprovedWfs(url, {
      fetchFn: async (_url, options) => {
        init = options;
        return new Response(activeJson, { headers: { 'content-type': 'application/json' } });
      },
      cache,
    });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['User-Agent'], CHROME_UA);
    assert.match(init.headers.Accept, /json/i);
    assert.equal(page.text, activeJson);
    assert.ok(cache.has(cwfisWfsCacheKey({ typeName: CWFIS_ACTIVE_LAYER, startIndex: 0 })));

    await assert.rejects(
      fetchApprovedWfs(url, {
        maxBytes: 10,
        fetchFn: async () => new Response(activeJson),
      }),
      /RESPONSE_TOO_LARGE/,
    );
  });

  it('does not bind fetch or import ais-relay', () => {
    assert.doesNotMatch(parseModuleSrc, /fetch\.bind/);
    assert.doesNotMatch(parseModuleSrc, /fetch\.bind\(globalThis\)/);
    assert.doesNotMatch(parseModuleSrc, /ais-relay/);
    assert.doesNotMatch(seederSrc, /fetch\.bind/);
    assert.doesNotMatch(seederSrc, /ais-relay/);
    assert.doesNotMatch(aisRelaySrc, /cwfif_national_activefires/);
    assert.doesNotMatch(aisRelaySrc, /geoserver\.cwfif\.nrcan\.gc\.ca/);
  });
});

describe('independent FIRMS + CWFIS merge', () => {
  it('publishes CWFIS when FIRMS fails, and FIRMS when CWFIS fails', async () => {
    const cwfisOnly = await mergeWildfireSources({
      fetchFirms: async () => { throw new Error('FIRMS down'); },
      fetchCwfis: async () => parseCwfisGeoJson(activeJson, 'active'),
    });
    assert.ok(cwfisOnly.fireDetections.length >= 1);
    assert.equal(cwfisOnly.fireDetections[0].source, 'cwfis');
    assert.equal(cwfisOnly._firmsCount, 0);

    const firmsOnly = await mergeWildfireSources({
      fetchFirms: async () => ({ fireDetections: [firmsDetection()] }),
      fetchCwfis: async () => { throw new Error('CWFIS down'); },
    });
    assert.equal(firmsOnly.fireDetections.length, 1);
    assert.equal(firmsOnly.fireDetections[0].source, 'firms');
    assert.equal(firmsOnly._cwfisCount, 0);
  });

  it('throws when every upstream fails', async () => {
    await assert.rejects(
      mergeWildfireSources({
        fetchFirms: async () => { throw new Error('FIRMS down'); },
        fetchCwfis: async () => { throw new Error('CWFIS down'); },
      }),
      /All wildfire upstreams failed/,
    );
  });

  it('keeps both sources when both succeed', async () => {
    const merged = await mergeWildfireSources({
      fetchFirms: async () => ({ fireDetections: [firmsDetection()] }),
      fetchCwfis: async () => parseCwfisGeoJson(activeJson, 'active'),
    });
    assert.equal(merged.fireDetections.filter((f) => f.source === 'firms').length, 1);
    assert.ok(merged.fireDetections.filter((f) => f.source === 'cwfis').length >= 1);
  });

  it('fetches active even if prescribed fails', async () => {
    let activeCalled = false;
    const result = await fetchCwfisFires({
      cqlFilter: '',
      pageSize: 2,
      maxPages: 1,
      fetchFn: async (url) => {
        const parsed = new URL(url);
        const typeName = parsed.searchParams.get('typeNames');
        if (typeName === CWFIS_PRESCRIBED_LAYER) {
          return new Response('nope', { status: 500 });
        }
        activeCalled = true;
        return new Response(JSON.stringify({
          ...JSON.parse(activeJson),
          numberMatched: 2,
        }), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(activeCalled, true);
    assert.ok(result.fireDetections.length >= 1);
    assert.equal(result.fireDetections[0].kind, 'active');
    assert.equal(result._cwfisState, 'degraded');
    assert.equal(result._cwfisErrorCode, 'CWFIS_PRESCRIBED_FAILED');
  });

  it('fails the CWFIS subsource when the active layer is incomplete', async () => {
    const activeFeature = JSON.parse(activeJson).features.slice(0, 1);
    const prescribedFeature = JSON.parse(prescribedJson).features.slice(0, 1);
    await assert.rejects(
      fetchCwfisFires({
        cqlFilter: '',
        pageSize: 1,
        maxPages: 1,
        fetchFn: async (url) => {
          const typeName = new URL(url).searchParams.get('typeNames');
          const active = typeName === CWFIS_ACTIVE_LAYER;
          return new Response(JSON.stringify({
            type: 'FeatureCollection',
            features: active ? activeFeature : prescribedFeature,
            numberMatched: active ? 2 : 1,
            numberReturned: 1,
            links: [],
          }), { headers: { 'content-type': 'application/json' } });
        },
      }),
      /CWFIS active layer failed:.*pagination incomplete.*1 of 2/i,
    );
  });

  it('publishes CWFIS fallback with health-visible FIRMS degradation metadata', async () => {
    const cwfisOnly = await mergeWildfireSources({
      fetchFirms: async () => { throw new Error('FIRMS key rejected'); },
      fetchCwfis: async () => parseCwfisGeoJson(activeJson, 'active'),
    });
    assert.equal(cwfisOnly._firmsState, 'failed');
    assert.equal(cwfisOnly._firmsErrorCode, 'FIRMS_SOURCE_FAILED');

    // A FIRMS outage drops the canonical wildfire key from ~15k worldwide
    // detections to Canada only. That must never publish as sourceState 'ok'.
    const patch = cwfisWildfireAfterPublish(cwfisOnly).freshnessMetaPatch;
    assert.equal(patch.sourceState, 'degraded');
    assert.equal(patch.errorCode, 'FIRMS_SOURCE_FAILED');
  });

  it('reports the global source first when both sources degrade', async () => {
    const patch = cwfisWildfireAfterPublish({
      _firmsState: 'failed',
      _firmsErrorCode: 'FIRMS_SOURCE_FAILED',
      _cwfisState: 'degraded',
      _cwfisErrorCode: 'CWFIS_PRESCRIBED_FAILED',
    }).freshnessMetaPatch;
    assert.equal(patch.sourceState, 'degraded');
    assert.equal(patch.errorCode, 'FIRMS_SOURCE_FAILED');
    assert.equal(patch.canadaSourceFailureCount, 1);
  });

  it('publishes FIRMS fallback with health-visible CWFIS degradation metadata', async () => {
    const firmsOnly = await mergeWildfireSources({
      fetchFirms: async () => ({ fireDetections: [firmsDetection()] }),
      fetchCwfis: async () => { throw new Error('active paging incomplete'); },
    });
    assert.equal(firmsOnly._cwfisState, 'failed');
    assert.equal(firmsOnly._cwfisErrorCode, 'CWFIS_SOURCE_FAILED');

    const patch = cwfisWildfireAfterPublish(firmsOnly).freshnessMetaPatch;
    assert.deepEqual(patch, {
      sourceState: 'degraded',
      errorCode: 'CWFIS_SOURCE_FAILED',
      canadaSourceFailureCount: 1,
    });

    const now = Date.parse('2026-08-14T12:00:00Z');
    const dataKey = healthTesting.BOOTSTRAP_KEYS.wildfires;
    const metaKey = healthTesting.SEED_META.wildfires.key;
    const entry = healthTesting.classifyKey('wildfires', dataKey, { allowOnDemand: false }, {
      keyStrens: new Map([[dataKey, 256]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: firmsOnly.fireDetections.length,
        ...patch,
      })]]),
      keyMetaErrors: new Map(),
      now,
    });
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.errorCode, 'CWFIS_SOURCE_FAILED');
  });
});


describe('default CQL archive guard', () => {
  it('locks record_end >= now as the default filter', () => {
    const now = new Date('2026-08-14T01:21:00.000Z');
    assert.equal(currentValidCql(now), 'record_end >= 2026-08-14T01:21:00Z');
    assert.equal(resolveCwfisCqlFilter(undefined, now), 'record_end >= 2026-08-14T01:21:00Z');
    assert.equal(resolveCwfisCqlFilter('', now), 'record_end >= 2026-08-14T01:21:00Z');
    assert.equal(resolveCwfisCqlFilter('   ', now), 'record_end >= 2026-08-14T01:21:00Z');
    assert.throws(() => resolveCwfisCqlFilter('agency_code=BC', now), /record_end/);
    assert.ok(CWFIS_ARCHIVE_MATCHED_REFUSAL < 187566);
    assert.throws(() => assertNotCwfisArchive(187566), /archive shape refused/);
    assert.doesNotThrow(() => assertNotCwfisArchive(584));
    const defaultUrl = buildCwfisGetFeatureUrl({ typeName: CWFIS_ACTIVE_LAYER, now });
    const emptyUrl = buildCwfisGetFeatureUrl({ typeName: CWFIS_ACTIVE_LAYER, cqlFilter: '', now });
    assert.match(new URL(defaultUrl).searchParams.get('CQL_FILTER') || '', /record_end >= 2026-08-14T01:21:00Z/);
    assert.equal(new URL(emptyUrl).searchParams.get('CQL_FILTER'), 'record_end >= 2026-08-14T01:21:00Z');
  });

  it('sends the default CQL even when tests pass an empty cqlFilter', async () => {
    const requests = [];
    await fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
      kind: 'active',
      pageSize: 2,
      maxPages: 1,
      cqlFilter: '',
      now: new Date('2026-08-14T01:21:00.000Z'),
      fetchFn: async (url) => {
        requests.push(url);
        const body = {
          type: 'FeatureCollection',
          features: JSON.parse(activeJson).features,
          numberMatched: 2,
          numberReturned: 2,
        };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.ok(requests.length >= 1);
    const parsed = new URL(requests[0]);
    assert.match(parsed.searchParams.get('CQL_FILTER') || '', /record_end >=/);
    assert.doesNotMatch(requests[0], /CQL_FILTER=$/);
  });

  it('refuses a 187k archive-shaped GetFeature page', async () => {
    await assert.rejects(
      fetchCwfisLayer(CWFIS_ACTIVE_LAYER, {
        kind: 'active',
        pageSize: 2,
        maxPages: 1,
        fetchFn: async () => new Response(JSON.stringify({
          type: 'FeatureCollection',
          features: JSON.parse(activeJson).features,
          numberMatched: 187566,
          numberReturned: 2,
        }), { headers: { 'content-type': 'application/json' } }),
      }),
      /archive shape refused/,
    );
  });
});

describe('module import contract', () => {
  it('tests import the WFS module, not the seeder', () => {
    assert.doesNotMatch(testSrc, /from ['"][^'"]*seed-fire-detections/);
    assert.doesNotMatch(parseModuleSrc, /from ['"][^'"]*seed-fire-detections/);
  });

  it('seeder merges FIRMS and CWFIS into the canonical wildfire key', () => {
    assert.match(seederSrc, /mergeWildfireSources/);
    assert.match(seederSrc, /fetchCwfisFires/);
    assert.match(seederSrc, /afterPublish:\s*canadianWildfireAfterPublish/);
    assert.match(seederSrc, /wildfire:fires:v1/);
    assert.doesNotMatch(seederSrc, /wildfire:canada/);
    assert.doesNotMatch(seederSrc, /fetch\.bind/);
  });

  it('thermal escalation skips prescribed burns', () => {
    assert.match(thermalSrc, /kind !== 'prescribed'|kind === 'prescribed'/);
  });
});
