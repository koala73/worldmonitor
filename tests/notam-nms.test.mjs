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
  coveredLocations,
  mergeClosureSources,
  noteLocations,
  parseQCoordinates,
  pruneExpired,
} from '../scripts/lib/nms-notam.mjs';
import {
  ACTIVATION_KEY,
  CLASSIFICATIONS,
  CLOSURES_KEY,
  CLOSURES_META_KEY,
  DELTA_MAX_WINDOW_MS,
  DELTA_OVERLAP_MS,
  FULL_LOAD_MIN_INTERVAL_MS,
  MAX_STALE_MIN,
  NMS_PROD_HOST,
  SEED_DOMAIN,
  SEED_RESOURCE,
  buildPayload,
  createNmsClient,
  fetchSnapshot,
  isDryRun,
  isProductionHost,
  publishTargets,
  publishTransform,
  syncState,
  validate,
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
// The fixture's KLAX NOTAM only restricts GA traffic, which classifyNotam
// ignores. The state and payload tests need an airport restriction, so they
// use a KLAX notice that restricts airline traffic.
const FEATURES = { ...FIXTURE, airport_partial: feature('airport_partial', { text: 'AD AP CLSD EXC SKED FLT, MEDEVAC AND EMERG' }) };

describe('classifyNotam', () => {
  it('treats QFALC "AD AP CLSD" as a closed aerodrome', () => {
    assert.deepEqual(classifyNotam(notamOf(FIXTURE.airport_closed)), { airport: 'closed' });
  });

  it('downgrades a closure that still admits traffic to restricted', () => {
    assert.deepEqual(classifyNotam(notamOf(FEATURES.airport_partial)), { airport: 'restricted' });
  });

  // Texts below are live FAA NMS production aerodrome NOTAMs (2026-10-24).
  const aerodrome = (text) => classifyNotam({ ...notamOf(FIXTURE.airport_partial), text });

  it('ignores standing restrictions that only limit GA, training, parking or one aircraft type', () => {
    // The KLAX fixture: airline traffic is unaffected.
    assert.equal(classifyNotam(notamOf(FIXTURE.airport_partial)), null);
    for (const text of [
      'AD AP CLSD TO NON-SKED TRANSIENT GA ACFT EXC 24HR PPR',
      'AD AP CLSD TO GA ACFT EXC PPR SIGNATURE 512-530-5451',
      'AD AP CLSD TO TRANSIENT ACFT EXC 30MIN PPR 512-353-2379',
      'AD AP CLSD TO NON SKED ACFT OPS MORE THAN 30 PAX SEATS EXC 24HR PPR',
      'AD AP CLSD TO COMMERCIAL AIR CARRIER DIVERTS EXC EMERG ACFT',
      'AD AP CLSD TO F-35 VTOL',
      'AD AP CLSD FOR PRKG TO ACFT WINGSPAN MORE THAN 60FT EXC PPR 864-364-5653',
      'AD CLSD TO VISITING FIXED-WING ACFT',
      'AD CLSD TO CIV TRG FLTS.',
      'AD CLSD FOR TRG FLIGHTS EXC ACFT BASED ON AD.',
    ]) assert.equal(aerodrome(text), null, text);
  });

  it('keeps restrictions that limit traffic in general', () => {
    for (const text of [
      'AERODROME CLSD EXCEPT FOR MEDICAL EMERGENCY AND FORCE MAJEURE FLIGHTS, INCLUDING MEDEVAC HELICOPTER OPERATIONS.',
      'AD CLSD TO ALL NIGHT OPERATIONS.',
      'AD CLSD TO IFR OPS.',
      'AD CLOSED TO ALL CIVIL VFR TFC EXC STATE ACFT, MIL FLIGHTS, AMBULANCE',
      'AD CLSD TO FLT OPS, EXC IN CASES WHERE FLIGHT OPS ARE PERMITTED',
      'AD AP CLSD EXC 24HR PPR 704-433-4024',
      // Unlisted traffic classes stay restrictions: only known narrow classes drop.
      'AD CLSD TO CIVIL ACFT EXC MIL',
      'AD CLSD TO COMMERCIAL FLIGHTS',
      'AD AP CLSD TO ACFT WINGSPAN MORE THAN 60FT EXC 24HR PPR 334-844-4597 EXT 1',
      'AD AP CLSD TO FIXED WING EXC 4HR PPR DLY 0400-1000',
      'AD CLSD FOR ARR/DEP OF ALL AIRPLANE TYPES DUE TO RWY REPAIR WIP, EXC: - SAR ACFT',
    ]) assert.deepEqual(aerodrome(text), { airport: 'restricted' }, text);
  });

  it('treats a closure to all traffic with no exception as closed', () => {
    for (const text of [
      'AD CLOSED TO ALL TFC.',
      'AERODROME CLSD TO ALL TRAFFIC.',
      'AD CLSD TO ALL ACFT OPS DUE CIVIL UNREST WI VCY OF AD.',
      'AD CLSD TO ALL FLIGHTS DUE TO SUSPENSION OF AD CERTIFICATE.',
    ]) assert.deepEqual(aerodrome(text), { airport: 'closed' }, text);
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

  it('centres a radius circle on the Q-line point the radius belongs to', () => {
    // The geometry Point is the EGNV aerodrome reference point; the Q-line
    // 5434N00119W is the danger area's centre, ~4.5 NM away (text: "RADIUS OF
    // 543357N 0011839W"). A 2 NM circle on the aerodrome would miss the area.
    const g = compactFeature(FIXTURE.danger_radius, NOW).g;
    assert.deepEqual(g.c, [-1.3167, 54.5667]);
    assert.equal(g.r, 2);
  });

  it('keeps the geometry point for a marker, where no radius is drawn', () => {
    const huge = compactFeature(FIXTURE.huge_radius, NOW);
    assert.deepEqual(huge.g.c, [-17.7667, 26.0333]);
    const tfr = compactFeature(FIXTURE.tfr_fdc, NOW);
    assert.deepEqual(tfr.g.c, [-79.6861, 32.3777]);
  });

  it('keeps polygons and falls back to Q-line coordinates for the centre', () => {
    const ring = [[-76.9357, 41.2386], [-76.9356, 41.2382], [-76.9114, 41.2425], [-76.9357, 41.2386]];
    const poly = compactFeature(feature('danger_radius', { coordinates: undefined }, { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [ring] }] }), NOW);
    assert.deepEqual(poly.g.p, [ring]);
    assert.deepEqual(poly.g.c, ring[0], 'no Point and no Q-line coordinates: centre is the first vertex');

    const qline = compactFeature(feature('danger_radius', { coordinates: '5434N00119W' }, { type: 'GeometryCollection', geometries: [] }), NOW);
    assert.deepEqual(qline.g.c, [-1.3167, 54.5667]);
  });

  it('treats malformed geometry as empty instead of aborting the sync', () => {
    // One bad feature must not throw out of applyFeatures and fail the run.
    for (const geometry of [
      { type: 'GeometryCollection', geometries: { type: 'Point' } },
      { type: 'GeometryCollection', geometries: [{ type: 'MultiPolygon', coordinates: null }] },
      { type: 'MultiPolygon', coordinates: 42 },
      { type: 'Polygon', coordinates: 'x' },
    ]) {
      const rec = compactFeature(feature('danger_radius', {}, geometry), NOW);
      assert.deepEqual(rec.g.c, [-1.3167, 54.5667], JSON.stringify(geometry));
      assert.equal(rec.g.p, undefined);
    }
  });

  it('drops an airspace NOTAM with no position at all', () => {
    const f = feature('tfr_fdc', { coordinates: undefined }, { type: 'GeometryCollection', geometries: [] });
    assert.equal(compactFeature(f, NOW), null);
  });

  // The map cannot draw it, but it still closes the airports in its FIR.
  it('keeps an airspace closure with no position, for coverage but not for the map', () => {
    const f = feature('tfr_fdc', { id: 'fir-clsd', coordinates: undefined, selectionCode: 'QAFLC', icaoLocation: 'OIIX', location: 'OIIX', affectedFir: 'OIIX', text: 'TEHRAN FIR CLSD' },
      { type: 'GeometryCollection', geometries: [] });
    const rec = compactFeature(f, NOW);
    assert.equal(rec?.k, 'closure');
    assert.equal(rec.g, undefined);
    const items = { [rec.id]: rec };
    assert.deepEqual(buildAirspace(items, NOW), [], 'nothing to draw');
    assert.deepEqual(coveredLocations({ OIIE: 'OIIX', OEJN: 'OEJD' }, items, NOW), ['OEJN']);
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
    assert.deepEqual(applyFeatures(items, Object.values(FEATURES), NOW), { upserted: 6, removed: 0 });
    const dangerId = notamOf(FIXTURE.danger_radius).id;
    assert.ok(items[dangerId]);
    // A delta re-emits a cancelled NOTAM with cancelationDate set.
    const cancelled = feature('danger_radius', { cancelationDate: '2026-10-24T14:40:00Z' });
    assert.deepEqual(applyFeatures(items, [cancelled], NOW), { upserted: 0, removed: 1 });
    assert.equal(items[dangerId], undefined);
  });

  it('prunes records whose window closed since the last run', () => {
    const items = {};
    applyFeatures(items, Object.values(FEATURES), NOW);
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
  applyFeatures(items, Object.values(FEATURES), NOW);

  it('reports only closures in effect now; closed wins over restricted', () => {
    const c = buildClosures(items, NOW);
    const closedLoc = notamOf(FIXTURE.airport_closed).location.toUpperCase();
    assert.deepEqual(c.closedIcaos, [closedLoc]);
    assert.deepEqual(c.restrictedIcaos, ['KLAX']);
    assert.ok(!c.closedIcaos.includes('LSZH'), 'LSZH closure starts Oct 26');
    assert.match(c.reasons.KLAX, /CLSD EXC SKED FLT/);

    const both = { ...items, extra: { ...items[notamOf(FIXTURE.airport_partial).id], id: 'extra', a: 'closed', txt: 'AD CLSD' } };
    const merged = buildClosures(both, NOW);
    assert.deepEqual(merged.closedIcaos.includes('KLAX') && merged.restrictedIcaos.includes('KLAX'), false);
    assert.ok(merged.closedIcaos.includes('KLAX'));
  });

  it('drops narrow restrictions stored before the classifier excluded them', () => {
    // Delta runs keep stored records as they were classified; a full load is
    // at most daily. A KLAX record saved as restricted must not wait for it.
    const legacy = { ...items[notamOf(FEATURES.airport_partial).id], id: 'legacy', a: 'restricted', loc: 'KLAS', txt: 'AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24 HR PPR 702-261-7775' };
    const mixed = { ...legacy, id: 'legacy-mixed', loc: 'KBOS', txt: 'Ad Ap Clsd To Non Sked Transient Ga Acft' };
    const c = buildClosures({ ...items, legacy, mixed }, NOW);
    assert.ok(!c.restrictedIcaos.includes('KLAS'));
    assert.ok(!c.restrictedIcaos.includes('KBOS'), 'stored text is matched case-insensitively, as classifyNotam does');
    assert.deepEqual(c.restrictedIcaos, ['KLAX']);
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

describe('noteLocations / coveredLocations', () => {
  it('records every aerodrome the feed carries a NOTAM for, relevant or not, with its FIR', () => {
    const locs = { OIIE: 'OIIX' };
    const routine = feature('airport_partial', { icaoLocation: 'oejn', affectedFir: 'oejd', text: 'TWY B CLSD' });
    const noFir = feature('airport_partial', { icaoLocation: 'OEMA', affectedFir: undefined });
    const fir = feature('tfr_fdc', { icaoLocation: 'ZNY', location: 'ZNY' });
    noteLocations(locs, [routine, noFir, fir, { properties: {} }, null]);
    assert.deepEqual(locs, { OIIE: 'OIIX', OEJN: 'OEJD', OEMA: '' }, 'four-letter ICAO locations only');
  });

  // A country-wide airspace closure is a NOTAM on the FIR, not on each
  // airport. Its airports have no closure NOTAM of their own, and must not
  // read as open while the airspace above them is closed.
  it('withholds coverage from airports in, or at, an airspace closed now', () => {
    const firClosure = feature('danger_radius', { id: 'fir-clsd', selectionCode: 'QAFLC', icaoLocation: 'OIIX', location: 'OIIX', affectedFir: 'OIIX', text: 'TEHRAN FIR CLSD' });
    // Production on 2026-10-25: "MCTR CLSD" at EPPR, inside FIR EPWW.
    const ctrClosure = feature('danger_radius', { id: 'ctr-clsd', selectionCode: 'QACLC', icaoLocation: 'EPPR', location: 'EPPR', affectedFir: 'EPWW', text: 'MCTR CLSD.' });
    const items = {};
    applyFeatures(items, [firClosure, ctrClosure], NOW);
    assert.deepEqual(Object.values(items).map((r) => r.k), ['closure', 'closure'], 'fixtures are airspace closures');
    const locs = { OIIE: 'OIIX', OISS: 'OIIX', OIIX: 'OIIX', OEJN: 'OEJD', OEMA: '', EPPR: 'EPWW', EPKK: 'EPWW' };
    assert.deepEqual(coveredLocations(locs, items, NOW), ['EPKK', 'OEJN', 'OEMA'], 'a control-zone closure leaves the rest of its FIR open');
    assert.deepEqual(coveredLocations(locs, items, Date.parse('2030-01-01T00:00:00Z')), Object.keys(locs).sort(),
      'an expired closure no longer withholds coverage');
    assert.deepEqual(coveredLocations(undefined, items, NOW), []);
  });
});

describe('syncState', () => {
  const quiet = () => {};

  it('a full load records the feed\'s locations; a delta adds to them', async () => {
    const routine = feature('airport_partial', { icaoLocation: 'OEJN', selectionCode: 'QMXLC', text: 'TWY B CLSD' });
    const full = await syncState({
      state: null, lastFullLoadAt: null, markFullLoad: async () => {},
      client: fakeClient({ classification: { INTERNATIONAL: [routine] } }), nowMs: NOW, log: quiet,
    });
    assert.deepEqual(full.state.locs, { OEJN: 'KZLA' });
    assert.equal(Object.keys(full.state.items).length, 0, 'the routine NOTAM itself is not tracked');

    const later = feature('airport_partial', { icaoLocation: 'OIIE', selectionCode: 'QMRLC', text: 'RWY 11L CLSD' });
    const delta = await syncState({
      state: full.state, lastFullLoadAt: NOW, markFullLoad: async () => assert.fail('no bulk load'),
      client: fakeClient({ delta: [later] }), nowMs: NOW + 5 * 60_000, log: quiet,
    });
    assert.deepEqual(delta.state.locs, { OEJN: 'KZLA', OIIE: 'KZLA' });

    const legacy = await syncState({
      state: { cursor: NOW, fullLoadAt: NOW, items: {} }, lastFullLoadAt: NOW, markFullLoad: async () => {},
      client: fakeClient({ delta: [later] }), nowMs: NOW + 5 * 60_000, log: quiet,
    });
    assert.deepEqual(legacy.state.locs, { OIIE: 'KZLA' }, 'state written before coverage existed starts from the delta');
  });

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

  // A store the deltas cannot complete (state lost after a failed bulk load,
  // or a cursor older than the 23h delta window) must not publish as current:
  // NOTAMs issued before the window would silently vanish under a fresh
  // generatedAt. It waits for the next bulk allowance, keeping last-good.
  it('never repeats a bulk load inside the allowance window, and never publishes a delta-only rebuild', async () => {
    const client = fakeClient({ delta: [FIXTURE.tfr_fdc] });
    await assert.rejects(
      syncState({ state: null, lastFullLoadAt: NOW - HOUR, markFullLoad: async () => assert.fail('bulk allowance already used'), client, nowMs: NOW, log: quiet }),
      (err) => err.preservableFetchFailure === true && err.nonRetryable === true && /bulk load/.test(err.message),
    );
    assert.deepEqual(client.calls, [], 'no pull: a 23h delta cannot rebuild older NOTAMs');
  });

  it('waits for the bulk allowance when the cursor is past the 23h delta window', async () => {
    const state = { cursor: NOW - 30 * HOUR, fullLoadAt: NOW - 30 * HOUR, items: {} };
    const client = fakeClient();
    await assert.rejects(
      syncState({ state, lastFullLoadAt: NOW - HOUR, markFullLoad: async () => assert.fail('blocked'), client, nowMs: NOW, log: quiet }),
      (err) => err.preservableFetchFailure === true && err.nonRetryable === true,
    );
    assert.deepEqual(client.calls, []);
  });

  it('keeps delta-syncing a complete store whose daily resync is blocked', async () => {
    const state = { cursor: NOW - 5 * 60_000, fullLoadAt: NOW - FULL_LOAD_MIN_INTERVAL_MS, items: {} };
    const client = fakeClient();
    const r = await syncState({ state, lastFullLoadAt: NOW - HOUR, markFullLoad: async () => assert.fail('blocked'), client, nowMs: NOW, log: quiet });
    assert.equal(r.mode, 'delta');
    assert.deepEqual(client.calls, [['delta', state.cursor - DELTA_OVERLAP_MS]]);
  });

  it('makes every failed pull single-attempt, so runSeed cannot re-pull inside the FAA 3-minute limit', async () => {
    const state = { cursor: NOW - 5 * 60_000, fullLoadAt: NOW - 2 * HOUR, items: {} };
    const client = fakeClient();
    client.delta = async () => { throw new Error('NMS GET /v1/notams HTTP 429'); };
    await assert.rejects(
      syncState({ state, lastFullLoadAt: NOW - 2 * HOUR, markFullLoad: async () => {}, client, nowMs: NOW, log: quiet }),
      (err) => err.nonRetryable === true && /HTTP 429/.test(err.message),
    );
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

  it('authenticates before claiming the bulk allowance, so an auth outage cannot spend it', async () => {
    const client = fakeClient();
    client.ready = async () => { throw new Error('NMS auth failed: HTTP 503'); };
    await assert.rejects(
      syncState({ state: null, lastFullLoadAt: null, markFullLoad: async () => assert.fail('guard claimed before auth'), client, nowMs: NOW, log: quiet }),
      /auth failed/,
    );
    assert.deepEqual(client.calls, []);
  });

  it('waits a full 24 hours between bulk loads', () => {
    assert.ok(FULL_LOAD_MIN_INTERVAL_MS >= 24 * HOUR, 'FAA allows one bulk load per 24 hours');
    assert.ok(DELTA_MAX_WINDOW_MS < FULL_LOAD_MIN_INTERVAL_MS);
  });
});

describe('runSeed wiring', () => {
  const items = {};
  applyFeatures(items, Object.values(FEATURES), NOW);

  // runSeed validates the publishTransform output (atomicPublish in
  // _seed-utils.mjs), not the raw fetch result.
  it('validate accepts the canonical payload runSeed actually publishes', () => {
    const published = publishTransform(buildPayload({ cursor: NOW, fullLoadAt: NOW, items }, NOW));
    assert.deepEqual(Object.keys(published).sort(), ['generatedAt', 'notams', 'source']);
    assert.equal(validate(published), true);
    assert.equal(validate({ generatedAt: NOW, source: 'FAA NMS' }), false);
  });

  it('persists the synced state before returning, so a failed publish cannot lose a bulk load', async () => {
    const order = [];
    const client = fakeClient({ classification: { FDC: [FIXTURE.tfr_fdc] } });
    const payload = await fetchSnapshot({
      readState: async () => null,
      readLastFullLoadAt: async () => null,
      markFullLoad: async () => { order.push('guard'); },
      persistState: async (state) => { order.push(['state', state.fullLoadAt]); },
      client,
      nowMs: NOW,
      log: () => {},
    });
    assert.deepEqual(order, ['guard', ['state', NOW]]);
    assert.equal(payload.notams.length, 1);
  });

  it('makes a failed state write single-attempt too, so runSeed cannot re-pull', async () => {
    const state = { cursor: NOW - 5 * 60_000, fullLoadAt: NOW - 2 * HOUR, items: {} };
    const client = fakeClient();
    await assert.rejects(
      fetchSnapshot({
        readState: async () => state,
        readLastFullLoadAt: async () => NOW - 2 * HOUR,
        markFullLoad: async () => {},
        persistState: async () => { throw new Error('Upstash SET failed'); },
        client,
        nowMs: NOW,
        log: () => {},
      }),
      (err) => err.nonRetryable === true && /Upstash/.test(err.message),
    );
    assert.equal(client.calls.length, 1, 'exactly one delta pull');
  });

  it('dry-runs on every non-production host unless explicitly allowed', () => {
    assert.equal(isDryRun(NMS_PROD_HOST, {}), false);
    assert.equal(isDryRun('https://api-staging.cgifederal-aim.com', {}), true);
    assert.equal(isDryRun('https://api-staging.cgifederal-aim.com', { NMS_ALLOW_NONPROD_WRITE: '1' }), false);
    assert.equal(isDryRun('https://api-staging.cgifederal-aim.com', { NMS_ALLOW_NONPROD_WRITE: 'true' }), true);
  });

  it('keeps pre-prod closures out of airport alerts and the health cutover', () => {
    const prod = publishTargets(NMS_PROD_HOST);
    assert.deepEqual(prod.extraKeys.map((k) => [k.key, k.metaKey]), [[CLOSURES_KEY, CLOSURES_META_KEY]]);
    assert.equal(prod.activates, true);
    const staging = publishTargets('https://api-staging.cgifederal-aim.com');
    assert.deepEqual(staging.extraKeys, [], 'FAA test closures (KJFK) must not reach seed-aviation');
    assert.equal(staging.activates, false);
  });

  it('matches the keys and staleness budget /api/health grades', async () => {
    const { __testing__ } = await import('../api/health.js');
    const { SEED_META, ACTIVATION_MARKERS } = __testing__;
    // runSeed writes the canonical meta as seed-meta:<domain>:<resource>.
    assert.equal(SEED_META.notamAirspace.key, `seed-meta:${SEED_DOMAIN}:${SEED_RESOURCE}`);
    assert.equal(SEED_META.notamNmsClosures.key, CLOSURES_META_KEY);
    for (const name of ['notamAirspace', 'notamNmsClosures']) {
      assert.equal(SEED_META[name].maxStaleMin, MAX_STALE_MIN, name);
      assert.equal(SEED_META[name].activationKey, ACTIVATION_KEY, name);
      assert.equal(ACTIVATION_MARKERS[name], ACTIVATION_KEY, name);
    }
  });
});

describe('mergeClosureSources', () => {
  it('closes an airport any source closes, takes the reason from a closing source, and drops unwatched airports', () => {
    const nms = { closedIcaos: ['OEJN'], restrictedIcaos: ['OEMA'], reasons: { OEJN: 'AD CLSD (NMS)', OEMA: 'RESTRICTED (NMS)' } };
    const icao = { closedIcaos: ['OEMA', 'KZZZ'], restrictedIcaos: ['OEDF'], reasons: { OEMA: 'AD CLSD (ICAO)', OEDF: 'PPR (ICAO)', KZZZ: 'AD CLSD' } };
    const merged = mergeClosureSources([{ label: 'FAA NMS NOTAM', snapshot: nms }, { label: 'ICAO NOTAM', snapshot: icao }, { label: 'x', snapshot: null }], ['OEJN', 'OEMA', 'OEDF']);
    assert.deepEqual(merged.closedIcaos.sort(), ['OEJN', 'OEMA']);
    assert.deepEqual(merged.restrictedIcaos, ['OEDF'], 'closed by ICAO beats restricted by NMS');
    // The closure alert is titled from this reason, so it must be closure text.
    assert.equal(merged.reasons.OEMA, 'AD CLSD (ICAO)');
    assert.deepEqual(merged.sourceByIcao, { OEJN: 'FAA NMS NOTAM', OEMA: 'ICAO NOTAM', OEDF: 'ICAO NOTAM' });
    assert.equal(merged.reasons.KZZZ, undefined);
  });

  it('falls back to the restriction note when no closing source gave a reason', () => {
    const nms = { closedIcaos: [], restrictedIcaos: ['OEMA'], reasons: { OEMA: 'RESTRICTED (NMS)' } };
    const icao = { closedIcaos: ['OEMA'], restrictedIcaos: [], reasons: {} };
    const merged = mergeClosureSources([{ label: 'FAA NMS NOTAM', snapshot: nms }, { label: 'ICAO NOTAM', snapshot: icao }], ['OEMA']);
    assert.deepEqual(merged.closedIcaos, ['OEMA']);
    assert.equal(merged.reasons.OEMA, 'RESTRICTED (NMS)');
    assert.equal(merged.sourceByIcao.OEMA, 'FAA NMS NOTAM');
  });

  it('keeps the coverage of watched airports only, from whichever source reports it', () => {
    const nms = { closedIcaos: [], restrictedIcaos: [], reasons: {}, coveredIcaos: ['OIIE', 'OEJN', 'KZZZ'] };
    const icao = { closedIcaos: ['OEMA'], restrictedIcaos: [], reasons: {} };
    const merged = mergeClosureSources([{ label: 'FAA NMS NOTAM', snapshot: nms }, { label: 'ICAO NOTAM', snapshot: icao }], ['OEJN', 'OEMA', 'OIIE']);
    assert.deepEqual(merged.coveredIcaos, ['OEJN', 'OIIE']);
    assert.deepEqual(mergeClosureSources([{ label: 'ICAO NOTAM', snapshot: icao }], ['OEMA']).coveredIcaos, []);
  });
});

describe('buildPayload', () => {
  it('splits the airspace layer from the closures extra key', () => {
    const items = {};
    applyFeatures(items, Object.values(FEATURES), NOW);
    const p = buildPayload({ cursor: NOW, fullLoadAt: NOW, items }, NOW);
    assert.equal(p.source, 'FAA NMS');
    assert.equal(p.notams.length, 3);
    assert.deepEqual(p.closures.restrictedIcaos, ['KLAX']);
    assert.equal(p.closures.generatedAt, NOW);
    assert.deepEqual(p.closures.coveredIcaos, []);
    assert.deepEqual(buildPayload({ cursor: NOW, fullLoadAt: NOW, items, locs: { OIIE: 'OIIX' } }, NOW).closures.coveredIcaos, ['OIIE']);
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
