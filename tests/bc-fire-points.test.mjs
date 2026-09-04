import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME_UA } from '../scripts/_seed-utils.mjs';
import { __testing__ as healthTesting } from '../api/health.js';
import { parseCwfisGeoJson } from '../scripts/wildfire/cwfis-wfs.mjs';
import {
  BC_FETCH_TIMEOUT_MS,
  BC_FIRE_KML_URL,
  BC_FIRE_LAYER,
  BC_OPENMAPS_HOST,
  BC_SOURCE,
  MAX_BC_RESPONSE_BYTES,
  bcFireCacheKey,
  buildBcWfsUrl,
  canadianWildfireAfterPublish,
  collectBcJoinKeys,
  collectCwfisJoinKeys,
  enrichOrAppendBc,
  fetchApprovedBcUrl,
  fetchBcFirePoints,
  latLonTimeKey,
  mergeWildfireSourcesWithBc,
  parseBcFireGeoJson,
  parseBcFireKml,
  stableBcFireId,
} from '../scripts/wildfire/bc-fire-points.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const kml = readFileSync(resolve(here, 'fixtures/wildfire/bc-current-fire-points.kml'), 'utf8');
const loaderKml = readFileSync(resolve(here, 'fixtures/wildfire/bc-current-fire-points-loader.kml'), 'utf8');
const geojson = readFileSync(resolve(here, 'fixtures/wildfire/bc-current-fire-points.json'), 'utf8');
const cwfisActiveJson = readFileSync(resolve(here, 'fixtures/wildfire/cwfis-national-activefires.json'), 'utf8');
const parseModuleSrc = readFileSync(resolve(here, '../scripts/wildfire/bc-fire-points.mjs'), 'utf8');
const cwfisModuleSrc = readFileSync(resolve(here, '../scripts/wildfire/cwfis-wfs.mjs'), 'utf8');
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const seederSrc = readFileSync(resolve(here, '../scripts/seed-fire-detections.mjs'), 'utf8');
const aisRelaySrc = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');
const railwaySrc = readFileSync(resolve(here, '../scripts/railway-services.json'), 'utf8');

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

describe('bc live fixture coordinates and status', () => {
  it('parses live KML placemark coordinates and fire status/kind', () => {
    const parsed = parseBcFireKml(kml);
    assert.ok(parsed.fireDetections.length >= 4);

    const brunswick = parsed.fireDetections.find((f) => f.fireNumber === 'V10742');
    assert.ok(brunswick);
    assert.equal(brunswick.source, BC_SOURCE);
    assert.equal(brunswick.kind, 'active');
    assert.equal(brunswick.emergency, true);
    assert.equal(brunswick.location.latitude, 49.8935);
    assert.equal(brunswick.location.longitude, -121.4548);
    assert.equal(brunswick.id, 'bc-wildfire:V10742');
    assert.ok(brunswick.id.length <= 100);
    assert.equal(brunswick.stageOfControl, 'Fire of Note');
    assert.equal(brunswick.region, 'British Columbia');
    assert.equal('latLonKey' in brunswick, false);
    assert.equal('latLonTimeKey' in brunswick, false);

    const cariboo = parsed.fireDetections.find((f) => f.fireNumber === 'C41588');
    assert.equal(cariboo.location.latitude, 51.5189);
    assert.equal(cariboo.location.longitude, -121.8707);
    assert.equal(cariboo.stageOfControl, 'Under Control');
  });

  it('parses the same live coordinates from WFS GeoJSON properties, not EPSG:3005 geometry', () => {
    const parsed = parseBcFireGeoJson(geojson);
    const brunswick = parsed.fireDetections.find((f) => f.fireNumber === 'V10742');
    assert.equal(brunswick.location.latitude, 49.8935);
    assert.equal(brunswick.location.longitude, -121.4548);
    assert.notEqual(brunswick.location.latitude, -121.45475);
    const out = parsed.fireDetections.find((f) => f.fireNumber === 'C20125');
    assert.equal(out.emergency, false);
    assert.equal(out.kind, 'active');
  });

  it('labels prescribed burns as not-emergency', () => {
    const parsed = parseBcFireKml(kml);
    const rx = parsed.fireDetections.find((f) => f.fireNumber === 'RX-DEMO');
    assert.ok(rx);
    assert.equal(rx.kind, 'prescribed');
    assert.equal(rx.emergency, false);
    assert.equal(rx.source, 'bc-wildfire');
    assert.equal(rx.fireWasPrescribed, 1);
  });

  it('uses the #6614 lat-lon-time bucket when native ids are missing', () => {
    const ignition = '2026-08-13T11:30:00Z';
    const id = stableBcFireId({
      LATITUDE: 49.89345,
      LONGITUDE: -121.45475,
      IGNITION_DATE: ignition,
    });
    const timeBucket = Math.round(Date.parse(ignition) / 60_000);
    assert.equal(id, `bc-wildfire:${(49.89345).toFixed(4)},${(-121.45475).toFixed(4)},${timeBucket}`);
    assert.equal(id, 'bc-wildfire:49.8935,-121.4548,29777010');
    assert.equal(latLonTimeKey(49.89345, -121.45475, Date.parse(ignition)), '49.8935,-121.4548,29777010');
    assert.ok(id.length <= 100);
  });

  it('treats the live loader KML as a same-host NetworkLink, not fire points', () => {
    const parsed = parseBcFireKml(loaderKml);
    assert.equal(parsed.fireDetections.length, 0);
    assert.ok(parsed.networkLinks.some((href) => href.includes(BC_FIRE_LAYER)));
    assert.ok(parsed.networkLinks.every((href) => href.includes(BC_OPENMAPS_HOST)));
  });
});

describe('dedup against #6664 nid-only cwfis:${year}_BC_${year}-${FIRE_NUMBER}', () => {
  it('does not double-count a BC point that matches cwfis:${national_fire_id}', () => {
    const cwfis = parseCwfisGeoJson(cwfisActiveJson, 'active').fireDetections;
    const bc = parseBcFireKml(kml).fireDetections;
    const merged = enrichOrAppendBc(cwfis, bc);
    const cariboo = merged.fireDetections.filter((f) => (
      f.id === 'cwfis:2026_BC_2026-C41588' || f.fireNumber === 'C41588' || f.nationalFireId === '2026_BC_2026-C41588'
    ));
    assert.equal(cariboo.length, 1);
    assert.equal(cariboo[0].source, 'cwfis');
    assert.equal(cariboo[0].id, 'cwfis:2026_BC_2026-C41588');
    assert.equal(cariboo[0].bcFireNumber, 'C41588');
    assert.ok(merged._bcEnrichedCount >= 2);

    const brunswickKeys = collectCwfisJoinKeys(cwfis.find((f) => f.nationalFireId === '2026_BC_2026-V10742'));
    assert.ok(brunswickKeys.has('cwfis:2026_BC_2026-V10742'));
    assert.equal(brunswickKeys.has('V10742'), false);
    assert.equal(brunswickKeys.has('49.8935,-121.4548'), false);
    const bcKeys = collectBcJoinKeys(bc.find((f) => f.fireNumber === 'V10742'));
    assert.ok(bcKeys.has('cwfis:2026_BC_2026-V10742'));
    assert.equal(bcKeys.has('V10742'), false);
    assert.equal(bcKeys.has('49.8935,-121.4548'), false);
    assert.ok([...bcKeys].some((key) => brunswickKeys.has(key)));
  });

  it('appends BC-only fires with a bc-wildfire native id', () => {
    const cwfis = parseCwfisGeoJson(cwfisActiveJson, 'active').fireDetections;
    const bc = parseBcFireKml(kml).fireDetections;
    const merged = enrichOrAppendBc(cwfis, bc);
    const onlyBc = merged.fireDetections.find((f) => f.fireNumber === 'C31543');
    assert.ok(onlyBc);
    assert.equal(onlyBc.source, 'bc-wildfire');
    assert.equal(onlyBc.id, 'bc-wildfire:C31543');
    assert.equal(onlyBc.kind, 'active');
    assert.equal(onlyBc.emergency, true);
  });

  it('does not append inactive Out / extinguished BC-only points', () => {
    const cwfis = parseCwfisGeoJson(cwfisActiveJson, 'active').fireDetections;
    const bc = parseBcFireGeoJson(geojson).fireDetections;
    const out = bc.find((f) => f.fireNumber === 'C20125');
    assert.ok(out);
    assert.equal(out.emergency, false);
    assert.equal(out.stageOfControl, 'Out');
    const merged = enrichOrAppendBc(cwfis, bc);
    assert.equal(merged.fireDetections.some((f) => f.fireNumber === 'C20125' && f.source === 'bc-wildfire'), false);
    assert.equal(merged.fireDetections.some((f) => f.id === 'bc-wildfire:C20125'), false);
    const activeOnly = merged.fireDetections.find((f) => f.fireNumber === 'C31543');
    assert.ok(activeOnly);
    assert.equal(activeOnly.source, 'bc-wildfire');
  });

  it('does not lat-lon join Out V30006 onto cwfis:2025_BC_2025-V32337', () => {
    const cwfis = [{
      id: 'cwfis:2025_BC_2025-V32337',
      location: { latitude: 50.5273, longitude: -122.4817 },
      source: 'cwfis',
      kind: 'active',
      emergency: true,
      nationalFireId: '2025_BC_2025-V32337',
      agencyFireId: 'V32337',
      stageOfControl: 'Under Control',
    }];
    const bc = [{
      id: 'bc-wildfire:V30006',
      location: { latitude: 50.5273, longitude: -122.4817 },
      source: 'bc-wildfire',
      kind: 'active',
      emergency: false,
      fireNumber: 'V30006',
      agencyFireId: 'V30006',
      stageOfControl: 'Out',
      fireYear: 2025,
      latLonKey: '50.5273,-122.4817',
      latLonTimeKey: latLonTimeKey(50.5273, -122.4817, 0),
    }];
    const cwfisKeys = collectCwfisJoinKeys(cwfis[0]);
    const bcKeys = collectBcJoinKeys(bc[0]);
    assert.ok(cwfisKeys.has('cwfis:2025_BC_2025-V32337'));
    assert.ok(bcKeys.has('cwfis:2025_BC_2025-V30006'));
    assert.equal(cwfisKeys.size, 1);
    assert.equal(bcKeys.size, 1);
    assert.equal(cwfisKeys.has('50.5273,-122.4817'), false);
    assert.equal(bcKeys.has('50.5273,-122.4817'), false);
    assert.equal(bcKeys.has('V30006'), false);
    assert.equal([...bcKeys].some((key) => cwfisKeys.has(key)), false);

    const merged = enrichOrAppendBc(cwfis, bc);
    assert.equal(merged.fireDetections.length, 1);
    assert.equal(merged.fireDetections[0].id, 'cwfis:2025_BC_2025-V32337');
    assert.equal(merged.fireDetections[0].source, 'cwfis');
    assert.equal(merged.fireDetections[0].bcFireNumber, undefined);
    assert.equal(merged.fireDetections[0].bcFireStatus, undefined);
    assert.equal(merged._bcEnrichedCount, 0);
    assert.equal(merged._bcAppendedCount, 0);
  });

  it('still enriches a matching CWFIS row with an Out status', () => {
    const cwfis = [{
      id: 'cwfis:2026_BC_2026-C20125',
      location: { latitude: 52.0234, longitude: -121.8296 },
      source: 'cwfis',
      kind: 'active',
      emergency: true,
      nationalFireId: '2026_BC_2026-C20125',
      agencyFireId: 'C20125',
    }];
    const bc = parseBcFireGeoJson(geojson).fireDetections.filter((f) => f.fireNumber === 'C20125');
    const merged = enrichOrAppendBc(cwfis, bc);
    assert.equal(merged.fireDetections.length, 1);
    assert.equal(merged.fireDetections[0].source, 'cwfis');
    assert.equal(merged.fireDetections[0].bcFireNumber, 'C20125');
    assert.equal(merged.fireDetections[0].bcFireStatus, 'Out');
    assert.equal(merged._bcAppendedCount, 0);
    assert.equal(merged._bcEnrichedCount, 1);
  });

  it('keeps prescribed labelling consistent with #6614 after merge', () => {
    const prescribedCwfis = [{
      id: 'cwfis:prescribed:2026_PC_2026JA2',
      location: { latitude: 52.8813, longitude: -118.1002 },
      source: 'cwfis',
      kind: 'prescribed',
      emergency: false,
      nationalFireId: '2026_PC_2026JA2',
      agencyFireId: '2026JA2',
      fireWasPrescribed: 1,
    }];
    const bc = parseBcFireKml(kml).fireDetections.filter((f) => f.kind === 'prescribed');
    const merged = enrichOrAppendBc(prescribedCwfis, bc);
    for (const fire of merged.fireDetections.filter((f) => f.kind === 'prescribed')) {
      assert.equal(fire.emergency, false);
    }
  });
});

describe('independent FIRMS + CWFIS + BC merge', () => {
  it('publishes BC when CWFIS fails, and CWFIS when BC fails, plus FIRMS', async () => {
    const bcOnly = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => { throw new Error('FIRMS down'); },
      fetchCwfis: async () => { throw new Error('CWFIS down'); },
      fetchBcWildfire: async () => parseBcFireKml(kml),
    });
    assert.ok(bcOnly.fireDetections.length >= 1);
    assert.equal(bcOnly.fireDetections[0].source, 'bc-wildfire');
    assert.equal(bcOnly._cwfisCount, 0);
    assert.equal(bcOnly._firmsCount, 0);

    const noBc = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => ({ fireDetections: [firmsDetection()] }),
      fetchCwfis: async () => parseCwfisGeoJson(cwfisActiveJson, 'active'),
      fetchBcWildfire: async () => { throw new Error('BC down'); },
    });
    assert.equal(noBc.fireDetections.filter((f) => f.source === 'firms').length, 1);
    assert.ok(noBc.fireDetections.filter((f) => f.source === 'cwfis').length >= 1);
    assert.equal(noBc._bcCount, 0);
    assert.equal(noBc._cwfisState, 'ok');
    assert.equal(noBc._bcState, 'failed');
    assert.equal(noBc._bcErrorCode, 'BC_WILDFIRE_SOURCE_FAILED');
  });

  it('grades a resolved-but-zero-coverage FIRMS fetch as failed, not ok', async () => {
    // fetchAllRegions catches every per-region error internally and always
    // resolves, so a total FIRMS outage settles 'fulfilled' with zero rows.
    // Grading on settlement alone published that as _firmsState 'ok', and the
    // canonical WORLDWIDE key silently became Canada-only while every
    // downstream content clock read it as healthy (#7141 follow-up).
    const silentOutage = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => ({
        fireDetections: [],
        pagination: undefined,
        _firmsFulfilledCalls: 0,
        _firmsFailedCalls: 27,
      }),
      fetchCwfis: async () => parseCwfisGeoJson(cwfisActiveJson, 'active'),
      fetchBcWildfire: async () => parseBcFireKml(kml),
    });

    assert.equal(silentOutage._firmsState, 'failed', 'zero successful region calls is an outage');
    assert.equal(silentOutage._firmsErrorCode, 'FIRMS_SOURCE_FAILED');
    assert.equal(silentOutage._firmsCount, 0);
    assert.equal(
      canadianWildfireAfterPublish(silentOutage).freshnessMetaPatch.sourceState,
      'degraded',
      'the canonical key must not report ok when it lost worldwide coverage',
    );
  });

  it('reports partial FIRMS coverage instead of passing it off as healthy', async () => {
    // The FIRMS regions partition the globe, so 26 of 27 failing means most of
    // the world went dark while the surviving region replaces the canonical
    // worldwide dataset. Coverage held, so this is not an outage — but it must
    // not read 'ok' either.
    const mostlyDark = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => ({
        fireDetections: [{ id: 'firms-1', detectedAt: Date.now() }],
        pagination: undefined,
        _firmsFulfilledCalls: 1,
        _firmsFailedCalls: 26,
      }),
      fetchCwfis: async () => parseCwfisGeoJson(cwfisActiveJson, 'active'),
      fetchBcWildfire: async () => parseBcFireKml(kml),
    });

    assert.equal(mostlyDark._firmsState, 'ok', 'some coverage survived, so not a full outage');
    assert.equal(mostlyDark._firmsPartial, true);
    assert.equal(mostlyDark._firmsFailedCalls, 26);
    assert.deepEqual(
      canadianWildfireAfterPublish(mostlyDark).freshnessMetaPatch,
      {
        sourceState: 'degraded',
        errorCode: 'FIRMS_PARTIAL_COVERAGE',
        canadaSourceFailureCount: 0,
      },
      'partial worldwide coverage must be visible, not silent',
    );
  });

  it('keeps FIRMS ok when some region calls succeed but return no rows', async () => {
    // A live worldwide window can legitimately be empty in the monitored
    // regions. That is coverage with nothing to report, not an outage.
    const emptyButLive = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => ({
        fireDetections: [],
        pagination: undefined,
        _firmsFulfilledCalls: 27,
        _firmsFailedCalls: 0,
      }),
      fetchCwfis: async () => parseCwfisGeoJson(cwfisActiveJson, 'active'),
      fetchBcWildfire: async () => parseBcFireKml(kml),
    });

    assert.equal(emptyButLive._firmsState, 'ok');
    assert.equal(emptyButLive._firmsErrorCode, null);
    assert.equal(emptyButLive._firmsPartial, false, 'full coverage is not partial');
    assert.equal(
      canadianWildfireAfterPublish(emptyButLive).freshnessMetaPatch.sourceState,
      'ok',
      'a live empty window with full coverage stays healthy',
    );
  });

  it('publishes Canada-only fallback with health-visible FIRMS degradation metadata', async () => {
    const canadaOnly = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => { throw new Error('FIRMS key rejected'); },
      fetchCwfis: async () => parseCwfisGeoJson(cwfisActiveJson, 'active'),
      fetchBcWildfire: async () => parseBcFireKml(kml),
    });
    assert.equal(canadaOnly._firmsState, 'failed');
    assert.equal(canadaOnly._firmsErrorCode, 'FIRMS_SOURCE_FAILED');
    assert.equal(canadaOnly._cwfisState, 'ok');
    assert.equal(canadaOnly._bcState, 'ok');

    // Both Canadian sources are healthy, so canadaSourceFailureCount stays 0 —
    // but the canonical key just lost its worldwide coverage. Never report 'ok'.
    const patch = canadianWildfireAfterPublish(canadaOnly).freshnessMetaPatch;
    assert.deepEqual(patch, {
      sourceState: 'degraded',
      errorCode: 'FIRMS_SOURCE_FAILED',
      canadaSourceFailureCount: 0,
    });
  });

  it('reports the global source first when FIRMS and a Canadian source both fail', async () => {
    const patch = canadianWildfireAfterPublish({
      _firmsState: 'failed',
      _firmsErrorCode: 'FIRMS_SOURCE_FAILED',
      _cwfisState: 'ok',
      _bcState: 'failed',
      _bcErrorCode: 'BC_WILDFIRE_SOURCE_FAILED',
    }).freshnessMetaPatch;
    assert.equal(patch.sourceState, 'degraded');
    assert.equal(patch.errorCode, 'FIRMS_SOURCE_FAILED');
    assert.equal(patch.canadaSourceFailureCount, 1);
  });

  it('publishes FIRMS fallback with health-visible BC degradation metadata', async () => {
    const merged = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => ({ fireDetections: [firmsDetection()] }),
      fetchCwfis: async () => parseCwfisGeoJson(cwfisActiveJson, 'active'),
      fetchBcWildfire: async () => { throw new Error('BC paging incomplete'); },
    });
    assert.equal(merged.fireDetections.filter((f) => f.source === 'firms').length, 1);
    assert.equal(merged._cwfisState, 'ok');
    assert.equal(merged._bcState, 'failed');

    const patch = canadianWildfireAfterPublish(merged).freshnessMetaPatch;
    assert.deepEqual(patch, {
      sourceState: 'degraded',
      errorCode: 'BC_WILDFIRE_SOURCE_FAILED',
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
        recordCount: merged.fireDetections.length,
        ...patch,
      })]]),
      keyMetaErrors: new Map(),
      now,
    });
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.errorCode, 'BC_WILDFIRE_SOURCE_FAILED');
  });

  it('uses one bounded health error when both required Canadian subsources fail', () => {
    assert.deepEqual(canadianWildfireAfterPublish({
      _cwfisState: 'degraded',
      _cwfisErrorCode: 'CWFIS_PRESCRIBED_FAILED',
      _bcState: 'ok',
    }).freshnessMetaPatch, {
      sourceState: 'degraded',
      errorCode: 'CWFIS_PRESCRIBED_FAILED',
      canadaSourceFailureCount: 1,
    });
    assert.deepEqual(canadianWildfireAfterPublish({
      _cwfisState: 'failed',
      _cwfisErrorCode: 'unexpected raw message',
      _bcState: 'failed',
      _bcErrorCode: 'unexpected raw message',
    }).freshnessMetaPatch, {
      sourceState: 'degraded',
      errorCode: 'CANADA_WILDFIRE_SOURCES_FAILED',
      canadaSourceFailureCount: 2,
    });
  });

  it('throws when every upstream fails', async () => {
    await assert.rejects(
      mergeWildfireSourcesWithBc({
        fetchFirms: async () => { throw new Error('FIRMS down'); },
        fetchCwfis: async () => { throw new Error('CWFIS down'); },
        fetchBcWildfire: async () => { throw new Error('BC down'); },
      }),
      /All wildfire upstreams failed/,
    );
  });
});

describe('host allowlist, cache key, transport', () => {
  it('includes the layer name PROT_CURRENT_FIRE_PNTS_SP in the cache key', () => {
    const kmlKey = bcFireCacheKey({ kind: 'kml' });
    const wfsKey = bcFireCacheKey({ kind: 'wfs', startIndex: 0 });
    assert.match(kmlKey, /PROT_CURRENT_FIRE_PNTS_SP/);
    assert.match(wfsKey, /PROT_CURRENT_FIRE_PNTS_SP/);
    assert.notEqual(kmlKey, wfsKey);
    assert.match(BC_FIRE_KML_URL, /PROT_CURRENT_FIRE_PNTS_SP_loader\.kml/);
    assert.equal(BC_OPENMAPS_HOST, 'openmaps.gov.bc.ca');
    assert.equal(BC_FIRE_LAYER, 'PROT_CURRENT_FIRE_PNTS_SP');
  });

  it('pins openmaps.gov.bc.ca, rejects redirects, caps bytes, sends CHROME_UA, no fetch.bind', async () => {
    assert.ok(MAX_BC_RESPONSE_BYTES >= 12 * 1024 * 1024);
    assert.ok(BC_FETCH_TIMEOUT_MS >= 15_000);
    assert.doesNotMatch(parseModuleSrc, /fetch\.bind/);
    assert.doesNotMatch(parseModuleSrc, /fetch\.bind\(globalThis\)/);

    let init;
    const cache = new Map();
    const page = await fetchApprovedBcUrl(BC_FIRE_KML_URL, {
      fetchFn: async (_url, options) => {
        init = options;
        return new Response(loaderKml, { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } });
      },
      cache,
    });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['User-Agent'], CHROME_UA);
    assert.equal(page.text, loaderKml);
    assert.ok(cache.has(bcFireCacheKey({ kind: 'kml' })));
    assert.match([...cache.keys()][0], /PROT_CURRENT_FIRE_PNTS_SP/);

    await assert.rejects(
      fetchApprovedBcUrl('https://example.com/not-openmaps.kml', {
        fetchFn: async () => new Response('nope'),
      }),
      /UNTRUSTED_SOURCE_HOST/,
    );
    await assert.rejects(
      fetchApprovedBcUrl(BC_FIRE_KML_URL, {
        maxBytes: 10,
        fetchFn: async () => new Response(loaderKml),
      }),
      /RESPONSE_TOO_LARGE/,
    );
  });

  it('SSRF: rejects http, file, loopback, metadata, and suffix-host lookalikes', async () => {
    const blocked = [
      'http://openmaps.gov.bc.ca/kml/geo/layers/WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP_loader.kml',
      'file:///etc/passwd',
      'https://127.0.0.1/latest/meta-data',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/kml',
      'https://openmaps.gov.bc.ca.evil.com/kml',
      'https://evil-openmaps.gov.bc.ca/kml',
    ];
    for (const url of blocked) {
      await assert.rejects(
        fetchApprovedBcUrl(url, { fetchFn: async () => new Response('nope') }),
        /UNTRUSTED_SOURCE_HOST/,
        `expected SSRF block for ${url}`,
      );
    }
  });

  it('SSRF: drops off-host NetworkLink targets without fetching them', async () => {
    const evilLoader = loaderKml.replace(
      'https://openmaps.gov.bc.ca/kml/geo/layers/WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP.kml',
      'https://169.254.169.254/latest/meta-data',
    );
    const requested = [];
    const result = await fetchBcFirePoints({
      pageSize: 4,
      maxPages: 1,
      fetchFn: async (url) => {
        requested.push(String(url));
        if (String(url).includes('/kml/')) {
          return new Response(evilLoader, { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } });
        }
        return new Response(geojson, { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(requested.some((url) => url.includes('169.254.169.254')), false);
    assert.equal(requested.some((url) => url.startsWith('http://')), false);
    assert.ok(result.fireDetections.length >= 1);
  });

  it('falls back to same-host WFS when the loader KML has no placemarks', async () => {
    const requests = [];
    const result = await fetchBcFirePoints({
      pageSize: 4,
      maxPages: 1,
      fetchFn: async (url) => {
        requests.push(url);
        if (String(url).includes('/kml/')) {
          return new Response(loaderKml, { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } });
        }
        return new Response(geojson, { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.ok(requests.some((url) => url.includes('PROT_CURRENT_FIRE_PNTS_SP_loader.kml')));
    assert.ok(requests.some((url) => url.includes('typeNames=') && url.includes('PROT_CURRENT_FIRE_PNTS_SP')));
    assert.equal(result._bcVia, 'wfs');
    assert.ok(result.fireDetections.length >= 3);
    assert.equal(result.fireDetections[0].source, 'bc-wildfire');
  });

  it('uses a stable WFS order and fails closed at an incomplete page cap', async () => {
    assert.equal(new URL(buildBcWfsUrl()).searchParams.get('sortBy'), 'OBJECTID');

    await assert.rejects(
      fetchBcFirePoints({
        pageSize: 4,
        maxPages: 1,
        fetchFn: async (url) => {
          if (String(url).includes('/kml/')) {
            return new Response(loaderKml, { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } });
          }
          return new Response(JSON.stringify({
            ...JSON.parse(geojson),
            numberMatched: 5,
          }), { headers: { 'content-type': 'application/json' } });
        },
      }),
      /pagination incomplete.*4 of 5/i,
    );
  });

  it('fails closed when WFS repeats a required page under a new startIndex', async () => {
    const first = JSON.parse(geojson).features.slice(0, 1);
    const requests = [];
    await assert.rejects(
      fetchBcFirePoints({
        pageSize: 1,
        maxPages: 2,
        fetchFn: async (url) => {
          requests.push(String(url));
          if (String(url).includes('/kml/')) {
            return new Response(loaderKml, { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } });
          }
          return new Response(JSON.stringify({
            type: 'FeatureCollection',
            features: first,
            numberMatched: 2,
            numberReturned: 1,
          }), { headers: { 'content-type': 'application/json' } });
        },
      }),
      /pagination repeated a page at startIndex=1/i,
    );
    assert.ok(requests.some((url) => new URL(url).searchParams.get('startIndex') === '0'));
    assert.ok(requests.some((url) => new URL(url).searchParams.get('startIndex') === '1'));
  });

  it('fails closed when WFS numberReturned disagrees with the response rows', async () => {
    assert.throws(
      () => parseBcFireGeoJson(JSON.stringify({
        type: 'FeatureCollection',
        features: JSON.parse(geojson).features.slice(0, 1),
        numberMatched: 1,
        numberReturned: 2,
      })),
      /numberReturned mismatch: declared 2, received 1/i,
    );
  });
});

describe('module import contract', () => {
  it('tests import the KML module, not the seeder', () => {
    assert.doesNotMatch(testSrc, /from ['"][^'"]*seed-fire-detections/);
    assert.doesNotMatch(parseModuleSrc, /from ['"][^'"]*seed-fire-detections/);
  });

  it('drops latLonKey / latLonTimeKey / raw fire-number from the join path', () => {
    assert.doesNotMatch(parseModuleSrc, /export function latLonKey/);
    assert.doesNotMatch(parseModuleSrc, /export function extractAgencyFireNumber/);
    assert.doesNotMatch(parseModuleSrc, /latLonKey:/);
    assert.doesNotMatch(parseModuleSrc, /latLonTimeKey:/);
    assert.match(parseModuleSrc, /cwfis:\$\{y\}_BC_\$\{y\}-\$\{number\}/);
  });

  it('does not add a second CWFIS client', () => {
    assert.doesNotMatch(parseModuleSrc, /geoserver\.cwfif\.nrcan\.gc\.ca/);
    assert.doesNotMatch(parseModuleSrc, /cwfif_national_activefires/);
    assert.doesNotMatch(parseModuleSrc, /fetchCwfisLayer/);
    assert.doesNotMatch(parseModuleSrc, /from ['"]\.\/cwfis-wfs/);
    assert.match(cwfisModuleSrc, /geoserver\.cwfif\.nrcan\.gc\.ca/);
  });

  it('does not touch ais-relay', () => {
    assert.doesNotMatch(parseModuleSrc, /ais-relay/);
    assert.doesNotMatch(seederSrc, /ais-relay/);
    assert.doesNotMatch(aisRelaySrc, /PROT_CURRENT_FIRE_PNTS_SP/);
    assert.doesNotMatch(aisRelaySrc, /openmaps\.gov\.bc\.ca/);
    assert.doesNotMatch(aisRelaySrc, /bc-wildfire/);
  });

  it('seeder merges BC into the canonical wildfire key and Railway watches the module', () => {
    assert.match(seederSrc, /mergeWildfireSourcesWithBc/);
    assert.match(seederSrc, /fetchBcFirePoints/);
    assert.match(seederSrc, /fetchCwfisFires/);
    assert.match(seederSrc, /afterPublish:\s*canadianWildfireAfterPublish/);
    assert.match(seederSrc, /wildfire:fires:v1/);
    assert.doesNotMatch(seederSrc, /wildfire:canada/);
    assert.doesNotMatch(seederSrc, /fetch\.bind/);
    assert.match(railwaySrc, /scripts\/wildfire\/bc-fire-points\.mjs/);
    assert.match(railwaySrc, /scripts\/wildfire\/cwfis-wfs\.mjs/);
  });
});
