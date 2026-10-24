// FAA NMS-API NOTAM seeder: classification, state maintenance, and the sync
// state machine that keeps the seeder inside NMS's production rate limits
// (one delta pull per 3 minutes, one bulk load per 24 hours).
//
// Fixture features are real NMS staging GeoJSON (tests/fixtures/
// nms-notam-geojson.json, notamTranslation stripped). NOW sits inside every
// "active" fixture's effective window.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  applyFeatures,
  buildAirspace,
  buildClosures,
  classifyNotam,
  compactFeature,
  parseQCoordinates,
  pruneExpired,
} from '../scripts/lib/nms-notam.mjs';
import {
  CLASSIFICATIONS,
  DELTA_MAX_WINDOW_MS,
  DELTA_OVERLAP_MS,
  FULL_LOAD_MIN_INTERVAL_MS,
  NMS_PROD_HOST,
  buildPayload,
  createNmsClient,
  isProductionHost,
  syncState,
} from '../scripts/seed-notam-nms.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/nms-notam-geojson.json', import.meta.url), 'utf8')).features;
const NOW = Date.parse('2026-10-24T14:48:00Z');
const HOUR = 3600_000;

const clone = (v) => structuredClone(v);
const notamOf = (f) => f.properties.coreNOTAMData.notam;
function feature(name, patch = {}, geometry) {
  const f = clone(FIXTURE[name]);
  Object.assign(notamOf(f), patch);
  if (geometry !== undefined) f.geometry = geometry;
  return f;
}

describe('classifyNotam', () => {
  it('treats QFALC "AD AP CLSD" as a closed aerodrome', () => {
    assert.deepEqual(classifyNotam(notamOf(FIXTURE.airport_closed)), { airport: 'closed' });
  });

  it('downgrades a closure that still admits traffic to restricted', () => {
    // KLAX: "AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR ..."
    assert.deepEqual(classifyNotam(notamOf(FIXTURE.airport_partial)), { airport: 'restricted' });
  });

  it('does not read routine aerodrome notices as closures', () => {
    // The ICAO classifier's FA+XX / "AD NOT AVBL" rules flag both of these.
    assert.equal(classifyNotam(notamOf(FIXTURE.not_avbl_as_altn)), null);
    assert.equal(classifyNotam(notamOf(FIXTURE.ad_hoc_slots)), null);
  });

  it('ignores runway closures, route closures and NOTAMC cancellations', () => {
    assert.equal(classifyNotam(notamOf(FIXTURE.runway_closed)), null);
    assert.equal(classifyNotam(notamOf(FIXTURE.route_closed)), null);
    assert.equal(classifyNotam(notamOf(FIXTURE.cancel_notam)), null);
  });

  it('maps airspace Q-codes and FDC TFR text to layer kinds', () => {
    assert.deepEqual(classifyNotam(notamOf(FIXTURE.tfr_fdc)), { airspace: 'tfr' });
    assert.deepEqual(classifyNotam(notamOf(FIXTURE.danger_radius)), { airspace: 'danger' });
    assert.deepEqual(classifyNotam(notamOf(FIXTURE.huge_radius)), { airspace: 'restricted' });
    assert.deepEqual(classifyNotam({ ...notamOf(FIXTURE.danger_radius), selectionCode: 'QAFLC', text: 'FIR CLSD' }), { airspace: 'closure' });
    assert.deepEqual(classifyNotam({ ...notamOf(FIXTURE.danger_radius), selectionCode: 'QRPCA', text: 'TEMPO PROHIBITED AREA' }), { airspace: 'prohibited' });
  });
});

describe('compactFeature', () => {
  it('keeps the airport key from `location` when icaoLocation is absent', () => {
    const rec = compactFeature(FIXTURE.airport_closed, NOW);
    assert.equal(rec.a, 'closed');
    assert.equal(rec.loc, notamOf(FIXTURE.airport_closed).location.toUpperCase());
    assert.equal(rec.g, undefined, 'airport-only records carry no geometry');
  });

  it('drops NOTAMs that are cancelled or expired at `now`', () => {
    assert.equal(compactFeature(feature('danger_radius', { cancelationDate: '2026-10-24T14:00:00Z' }), NOW), null);
    assert.equal(compactFeature(feature('danger_radius', { effectiveEnd: '2026-10-24T14:47:00Z' }), NOW), null);
    assert.ok(compactFeature(feature('danger_radius', { cancelationDate: '2026-10-25T00:00:00Z' }), NOW), 'a future cancelation date is not a cancellation yet');
  });

  it('draws a radius circle, but not past the 250 NM cap', () => {
    assert.equal(compactFeature(FIXTURE.danger_radius, NOW).g.r, 2);
    const huge = compactFeature(FIXTURE.huge_radius, NOW);
    assert.equal(notamOf(FIXTURE.huge_radius).radius, '527');
    assert.equal(huge.g.r, undefined);
    assert.ok(Array.isArray(huge.g.c));
  });

  it('keeps polygons and falls back to Q-line coordinates for the centre', () => {
    const ring = [[-76.9357, 41.2386], [-76.9356, 41.2382], [-76.9114, 41.2425], [-76.9357, 41.2386]];
    const poly = compactFeature(feature('danger_radius', { coordinates: undefined }, { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [ring] }] }), NOW);
    assert.deepEqual(poly.g.p, [ring]);
    assert.deepEqual(poly.g.c, ring[0], 'no Point and no Q-line coordinates: centre is the first vertex');

    const qline = compactFeature(feature('danger_radius', { coordinates: '5434N00119W' }, { type: 'GeometryCollection', geometries: [] }), NOW);
    assert.deepEqual(qline.g.c, [-1.3167, 54.5667]);
  });

  it('drops an airspace NOTAM with no position at all', () => {
    const f = feature('tfr_fdc', { coordinates: undefined }, { type: 'GeometryCollection', geometries: [] });
    assert.equal(compactFeature(f, NOW), null);
  });
});

describe('parseQCoordinates', () => {
  it('parses degree-minute and degree-minute-second forms', () => {
    assert.deepEqual(parseQCoordinates('3939N04302E'), [43.0333, 39.65]);
    assert.deepEqual(parseQCoordinates('512615N0003215W'), [-0.5375, 51.4375]);
    assert.equal(parseQCoordinates('9939N04302E'), null);
    assert.equal(parseQCoordinates(''), null);
  });
});

describe('applyFeatures / pruneExpired', () => {
  it('upserts relevant NOTAMs and deletes ids whose new version no longer qualifies', () => {
    const items = {};
    // 6 of 11: three airport closures (closed, partial, future), tfr, danger,
    // huge-radius restricted. The rest classify as irrelevant.
    assert.deepEqual(applyFeatures(items, Object.values(FIXTURE), NOW), { upserted: 6, removed: 0 });
    const dangerId = notamOf(FIXTURE.danger_radius).id;
    assert.ok(items[dangerId]);
    // A delta re-emits a cancelled NOTAM with cancelationDate set.
    const cancelled = feature('danger_radius', { cancelationDate: '2026-10-24T14:40:00Z' });
    assert.deepEqual(applyFeatures(items, [cancelled], NOW), { upserted: 0, removed: 1 });
    assert.equal(items[dangerId], undefined);
  });

  it('prunes records whose window closed since the last run', () => {
    const items = {};
    applyFeatures(items, Object.values(FIXTURE), NOW);
    const before = Object.keys(items).length;
    const removed = pruneExpired(items, Date.parse('2026-10-31T00:00:00Z'));
    // airport_closed (Oct 30), danger_radius (Nov 1 — still live), huge_radius
    // (Oct 26) and airport_future (Oct 27) — three windows closed by Oct 31.
    assert.equal(removed, 3);
    assert.equal(Object.keys(items).length, before - 3);
  });
});

describe('buildClosures / buildAirspace', () => {
  const items = {};
  applyFeatures(items, Object.values(FIXTURE), NOW);

  it('reports only closures in effect now; closed wins over restricted', () => {
    const c = buildClosures(items, NOW);
    const closedLoc = notamOf(FIXTURE.airport_closed).location.toUpperCase();
    assert.deepEqual(c.closedIcaos, [closedLoc]);
    assert.deepEqual(c.restrictedIcaos, ['KLAX']);
    assert.ok(!c.closedIcaos.includes('LSZH'), 'LSZH closure starts Oct 26');
    assert.match(c.reasons.KLAX, /CLSD TO NON SKED/);

    const both = { ...items, extra: { ...items[notamOf(FIXTURE.airport_partial).id], id: 'extra', a: 'closed', txt: 'AD CLSD' } };
    const merged = buildClosures(both, NOW);
    assert.deepEqual(merged.closedIcaos.includes('KLAX') && merged.restrictedIcaos.includes('KLAX'), false);
    assert.ok(merged.closedIcaos.includes('KLAX'));
  });

  it('lists active airspace and flags NOTAMs starting within 24h as upcoming', () => {
    const rows = buildAirspace(items, NOW);
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['danger', 'restricted', 'tfr']);
    assert.ok(rows.every((r) => !r.upcoming));
    const later = buildAirspace(items, Date.parse('2026-09-04T00:00:00Z'));
    const tfr = later.find((r) => r.kind === 'tfr');
    assert.equal(tfr.upcoming, true, 'TFR starts 2026-09-04T12:12Z, inside the 24h horizon');
    assert.equal(buildAirspace(items, Date.parse('2026-09-02T00:00:00Z')).some((r) => r.kind === 'tfr'), false);
  });
});

function fakeClient({ classification = {}, delta = [] } = {}) {
  const calls = [];
  return {
    calls,
    async classification(cls) { calls.push(['classification', cls]); return classification[cls] || []; },
    async delta(since) { calls.push(['delta', since]); return delta; },
  };
}

describe('syncState', () => {
  const quiet = () => {};

  it('cold start: claims the bulk allowance before pulling all four classifications', async () => {
    const client = fakeClient({ classification: { INTERNATIONAL: [FIXTURE.danger_radius], FDC: [FIXTURE.tfr_fdc] } });
    const order = [];
    const markFullLoad = async (at) => { order.push(['guard', at]); };
    const origClassification = client.classification;
    client.classification = async (cls) => { order.push(['pull', cls]); return origClassification(cls); };
    const r = await syncState({ state: null, lastFullLoadAt: null, markFullLoad, client, nowMs: NOW, log: quiet });
    assert.equal(r.mode, 'full');
    assert.deepEqual(order[0], ['guard', NOW], 'guard is written before any bulk pull');
    assert.deepEqual(order.slice(1).map((o) => o[1]), CLASSIFICATIONS);
    assert.equal(r.state.cursor, NOW - DELTA_OVERLAP_MS);
    assert.equal(r.state.fullLoadAt, NOW);
    assert.equal(Object.keys(r.state.items).length, 2);
  });

  it('steady state: one delta from the cursor minus the overlap, no bulk pull', async () => {
    const state = { cursor: NOW - 5 * 60_000, fullLoadAt: NOW - 2 * HOUR, items: {} };
    applyFeatures(state.items, [FIXTURE.danger_radius], NOW);
    const cancelled = feature('danger_radius', { cancelationDate: '2026-10-24T14:45:00Z' });
    const client = fakeClient({ delta: [cancelled, FIXTURE.tfr_fdc] });
    const r = await syncState({ state, lastFullLoadAt: NOW - 2 * HOUR, markFullLoad: async () => assert.fail('no bulk load'), client, nowMs: NOW, log: quiet });
    assert.equal(r.mode, 'delta');
    assert.deepEqual(client.calls, [['delta', state.cursor - DELTA_OVERLAP_MS]]);
    assert.deepEqual(Object.values(r.state.items).map((i) => i.k), ['tfr']);
    assert.equal(r.state.cursor, NOW);
    assert.equal(r.state.fullLoadAt, state.fullLoadAt);
    assert.ok(state.items[notamOf(FIXTURE.danger_radius).id], 'input state is not mutated');
  });

  it('resyncs once the last bulk load is a day old', async () => {
    const state = { cursor: NOW - 5 * 60_000, fullLoadAt: NOW - FULL_LOAD_MIN_INTERVAL_MS, items: {} };
    const client = fakeClient();
    const r = await syncState({ state, lastFullLoadAt: NOW - FULL_LOAD_MIN_INTERVAL_MS, markFullLoad: async () => {}, client, nowMs: NOW, log: quiet });
    assert.equal(r.mode, 'full');
  });

  it('never repeats a bulk load inside the allowance window, even with state lost', async () => {
    const client = fakeClient({ delta: [FIXTURE.tfr_fdc] });
    const r = await syncState({ state: null, lastFullLoadAt: NOW - HOUR, markFullLoad: async () => assert.fail('bulk allowance already used'), client, nowMs: NOW, log: quiet });
    assert.equal(r.mode, 'delta');
    assert.deepEqual(client.calls, [['delta', NOW - DELTA_MAX_WINDOW_MS]], 'rebuilds from the widest delta NMS allows');
    assert.equal(Object.keys(r.state.items).length, 1);
  });

  it('caps a stale cursor at the 23h delta window when a resync is blocked', async () => {
    const state = { cursor: NOW - 30 * HOUR, fullLoadAt: NOW - 30 * HOUR, items: {} };
    const client = fakeClient();
    await syncState({ state, lastFullLoadAt: NOW - HOUR, markFullLoad: async () => assert.fail('blocked'), client, nowMs: NOW, log: quiet });
    assert.deepEqual(client.calls, [['delta', NOW - DELTA_MAX_WINDOW_MS]]);
  });

  it('propagates a failed bulk pull after the guard is claimed', async () => {
    let guarded = false;
    const client = fakeClient();
    client.classification = async () => { throw new Error('NMS GET /v1/notams HTTP 503'); };
    await assert.rejects(
      syncState({ state: null, lastFullLoadAt: null, markFullLoad: async () => { guarded = true; }, client, nowMs: NOW, log: quiet }),
      /HTTP 503/,
    );
    assert.equal(guarded, true);
  });
});

describe('buildPayload', () => {
  it('splits the airspace layer from the closures extra key', () => {
    const items = {};
    applyFeatures(items, Object.values(FIXTURE), NOW);
    const p = buildPayload({ cursor: NOW, fullLoadAt: NOW, items }, NOW);
    assert.equal(p.source, 'FAA NMS');
    assert.equal(p.notams.length, 3);
    assert.deepEqual(p.closures.restrictedIcaos, ['KLAX']);
    assert.equal(p.closures.generatedAt, NOW);
  });
});

describe('createNmsClient', () => {
  function respond(status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    return new Response(isBuf ? body : JSON.stringify(body), { status, headers: { 'content-type': isBuf ? 'application/octet-stream' : 'application/json', ...headers } });
  }

  it('authenticates once with client credentials and sends the GEOJSON format header', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      if (String(url).endsWith('/v1/auth/token')) return respond(200, { access_token: 'tok', expires_in: '1799' });
      return respond(200, { status: 'Success', data: { geojson: [FIXTURE.tfr_fdc] } });
    };
    const client = createNmsClient({ host: 'https://nms.test/', clientId: 'id', clientSecret: 'secret', fetchImpl, sleep: async () => {} });
    const features = await client.delta(Date.parse('2026-10-24T14:00:00.123Z'));
    await client.delta(NOW);
    assert.equal(features.length, 1);
    assert.equal(seen.filter((s) => s.url.endsWith('/v1/auth/token')).length, 1);
    const auth = seen[0];
    assert.equal(auth.url, 'https://nms.test/v1/auth/token', 'token endpoint has no /nmsapi prefix');
    assert.equal(auth.init.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
    assert.equal(auth.init.body, 'grant_type=client_credentials');
    assert.equal(seen[1].url, 'https://nms.test/nmsapi/v1/notams?lastUpdatedDate=2026-10-24T14%3A00%3A00Z');
    assert.equal(seen[1].init.headers.Authorization, 'Bearer tok');
    assert.equal(seen[1].init.headers.nmsResponseFormat, 'GEOJSON');
  });

  it('follows the classification content path and gunzips the file', async () => {
    const { gzipSync } = await import('node:zlib');
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/auth/token')) return respond(200, { access_token: 'tok' });
      if (u.includes('classification=FDC')) return respond(200, { status: 'Success', data: { url: '/nmsapi/v1/content/abc' } });
      if (u === 'https://nms.test/nmsapi/v1/content/abc') return respond(200, gzipSync(JSON.stringify([FIXTURE.tfr_fdc])));
      throw new Error(`unexpected ${u}`);
    };
    const client = createNmsClient({ host: 'https://nms.test', clientId: 'id', clientSecret: 's', fetchImpl, sleep: async () => {} });
    assert.equal((await client.classification('FDC')).length, 1);
  });

  it('fails loudly on rejected credentials but marks NMS outages preservable', async () => {
    const rejected = createNmsClient({ host: 'https://nms.test', clientId: 'id', clientSecret: 's', sleep: async () => {},
      fetchImpl: async () => respond(401, { ErrorCode: 'invalid_client', Error: 'Client credentials are invalid' }) });
    const authErr = await rejected.delta(NOW).catch((e) => e);
    assert.match(authErr.message, /auth rejected/);
    assert.notEqual(authErr.preservableFetchFailure, true);

    const down = createNmsClient({ host: 'https://nms.test', clientId: 'id', clientSecret: 's', sleep: async () => {},
      fetchImpl: async (url) => (String(url).endsWith('/v1/auth/token') ? respond(200, { access_token: 'tok' }) : respond(503, { status: '503', message: 'Service unavailable' })) });
    const outage = await down.delta(NOW).catch((e) => e);
    assert.equal(outage.preservableFetchFailure, true);

    const failure = createNmsClient({ host: 'https://nms.test', clientId: 'id', clientSecret: 's', sleep: async () => {},
      fetchImpl: async (url) => (String(url).endsWith('/v1/auth/token') ? respond(200, { access_token: 'tok' }) : respond(200, { status: 'Failure', errors: [{ code: '1', message: 'x' }] })) });
    await assert.rejects(failure.delta(NOW), /without a geojson array/);
  });
});

describe('isProductionHost', () => {
  it('only the FAA production host publishes by default', () => {
    assert.equal(isProductionHost(NMS_PROD_HOST), true);
    assert.equal(isProductionHost(`${NMS_PROD_HOST}/`), true);
    assert.equal(isProductionHost('https://api-staging.cgifederal-aim.com'), false);
    assert.equal(isProductionHost('https://api-fit.cgifederal-aim.com'), false);
  });
});
