import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { parseEmergencyResponse } from '../server/worldmonitor/aviation/v1/aircraft-emergency-source';
import { fetchCacheableEmergencySnapshot, fetchEmergencySnapshot, listAircraftEmergencies } from '../server/worldmonitor/aviation/v1/list-aircraft-emergencies';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import {
  CLOCK_SKEW_TOLERANCE_MS, EMERGENCY_CODES, EMERGENCY_RETENTION_MS, OBSERVATION_MAX_AGE_MS, emergencyMarkerPosition, isEmergencySquawk, isFresh,
  reconcileEmergencies as reconcileRecords, type EmergencyRecord, type EmergencySnapshot,
} from '../shared/aircraft-emergencies';
import { convertToStates, filterMilitaryFlights } from '../scripts/seed-military-flights.mjs';
import { summarizeMilitaryTheaters } from '../scripts/_military-surges.mjs';

const directory = new URL('./fixtures/aircraft-emergencies/', import.meta.url);
const synthetic = JSON.parse(readFileSync(new URL('synthetic.json', directory), 'utf8'));
const now = synthetic.now;
const parse = (rows = synthetic.ac, time = now) => parseEmergencyResponse({ now, ac: rows }, '7700', time);
const empty: EmergencySnapshot = { observations: [], feeds: [] };
const unknownReceipts = new Map<string, number>();
const reconcileEmergencies = (previous: EmergencyRecord[], snapshot: EmergencySnapshot, time: number) =>
  reconcileRecords(previous, snapshot, time, unknownReceipts);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; unknownReceipts.clear(); });

describe('timestamped unaltered captures', () => {
  it('verifies capture bytes and replays actual responses without inventing emergency records', () => {
    const captured = new URL('captured/', directory);
    for (const file of readdirSync(captured).filter(file => file.endsWith('.meta.json'))) {
      const metadata = JSON.parse(readFileSync(new URL(file, captured), 'utf8'));
      const raw = readFileSync(new URL(file.replace('.meta.json', '.json'), captured));
      assert.equal(createHash('sha256').update(raw).digest('hex'), metadata.sha256);
      assert.ok(Number.isFinite(Date.parse(metadata.receivedAt)));
      const response = parseEmergencyResponse(JSON.parse(raw.toString()), '7700', Date.parse(metadata.receivedAt));
      assert.equal(response.observations.length, 0, file);
      assert.equal(response.feeds[0]?.status, 'available', file);
    }
  });
});

describe('explicitly synthetic signal and freshness cases', () => {
  it('includes every code on both database classifications', () => {
    const result = parse();
    assert.equal(result.observations.length, 6);
    for (const code of EMERGENCY_CODES) {
      assert.deepEqual(result.observations.filter(row => row.squawk === code).map(row => row.militaryFlag).sort(), ['not_set', 'set']);
    }
    const records = reconcileEmergencies([], result, now);
    assert.equal(records.filter(row => emergencyMarkerPosition(row, now)).length, 6);
    assert.equal(records[0]?.observations[0]?.observedAt, now - 2000);
    assert.equal(records[0]?.observations[0]?.position?.observedAt, now - 3000);
  });

  it('matches exact four-character squawks and ignores separate emergency status', () => {
    for (const code of ['7501', '1200', ' 7500', '7500 ', '07500', '77000', '', 7500, null, undefined]) assert.equal(isEmergencySquawk(code), false);
    const result = parse([{ hex: 'abcdef', squawk: '1200', emergency: 'general' }, { hex: 'a00001', emergency: 'unlawful' }]);
    assert.deepEqual(result.observations, []);
    assert.equal(result.feeds[0]?.status, 'available');
    assert.equal(parse([{ hex: 'a00001', squawk: '7700', emergency: 'none' }]).observations.length, 1);
  });

  it('keeps unknown details and missing positions without making map markers', () => {
    const result = parse([{ hex: 'abcdef', squawk: '7500' }]);
    const row = result.observations[0]!;
    assert.equal(row.observedAt, 0);
    assert.equal(row.callsign, '');
    assert.equal(row.altitudeFt, undefined);
    assert.equal(row.position, undefined);
    const records = reconcileEmergencies([], result, now);
    assert.equal(records[0]?.state, 'unknown');
    assert.equal(emergencyMarkerPosition(records[0]!, now), undefined);
    assert.deepEqual(reconcileEmergencies(records, empty, now + EMERGENCY_RETENTION_MS + 1), []);
  });

  it('requires separate valid position freshness and accepts zero coordinates', () => {
    for (const value of [undefined, null, -1, '0', 91]) {
      const records = reconcileEmergencies([], parse([{ hex: 'abcdef', squawk: '7600', seen: 0, lat: 0, lon: 0, seen_pos: value }]), now);
      assert.equal(records[0]?.state, 'current');
      assert.equal(emergencyMarkerPosition(records[0]!, now), undefined);
    }
    const record = reconcileEmergencies([], parse([{ hex: 'abcdef', squawk: '7600', seen: 0, lat: 0, lon: 0, seen_pos: 90 }]), now)[0]!;
    assert.deepEqual(emergencyMarkerPosition(record, now), { lat: 0, lon: 0, observedAt: now - 90_000 });
    assert.equal(emergencyMarkerPosition(record, now + 1), undefined);
    for (const lat of [NaN, Infinity, 91, '0', null]) assert.equal(parse([{ hex: 'abcdef', squawk: '7700', lat, lon: 0 }]).observations[0]?.position, undefined);
  });

  it('does not readmit continuously reported unknown-clock aircraft after expiry', () => {
    const row = { hex: 'abcdef', squawk: '7500' };
    let records = reconcileEmergencies([], parse([row]), now);
    for (const offset of [EMERGENCY_RETENTION_MS, EMERGENCY_RETENTION_MS + 1, EMERGENCY_RETENTION_MS * 2, EMERGENCY_RETENTION_MS * 3]) {
      const time = now + offset;
      const snapshot = parseEmergencyResponse({ now: time, ac: [row] }, '7500', time);
      records = reconcileEmergencies(records, snapshot, time);
      assert.equal(records.length, offset <= EMERGENCY_RETENTION_MS ? 1 : 0, `retention at ${offset}ms`);
    }
    assert.equal(unknownReceipts.get('abcdef'), now);
    records = reconcileEmergencies(records, empty, now + EMERGENCY_RETENTION_MS * 4);
    assert.equal(unknownReceipts.get('abcdef'), now, 'unavailable data cannot reset the first receipt');
  });

  it('clears only expiry bookkeeping after successful absence or a timestamped report', () => {
    const snapshot = parse([{ hex: 'abcdef', squawk: '7500' }]);
    let records = reconcileEmergencies([], snapshot, now);
    const time = now + EMERGENCY_RETENTION_MS + 1;
    const feeds = EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status: 'available', fetchedAt: time, message: '' }));
    records = reconcileEmergencies(records, { observations: [], feeds: feeds.slice(0, 1) }, time);
    assert.equal(unknownReceipts.get('abcdef'), now, 'partial success cannot establish absence');
    records = reconcileEmergencies(records, { observations: [], feeds }, time);
    assert.equal(unknownReceipts.size, 0);
    records = reconcileEmergencies(records, snapshot, time + 1);
    assert.equal(records.length, 1, 'a later unknown report after successful absence starts a new receipt period');
    const timestamped = parseEmergencyResponse({ now: time + 2, ac: [{ hex: 'abcdef', squawk: '7500', seen: 0 }] }, '7500', time + 2);
    records = reconcileEmergencies(records, timestamped, time + 2);
    assert.equal(records[0]?.state, 'current');
    assert.equal(unknownReceipts.size, 0);
  });

  it('expires observation freshness on a controlled clock without fresh retrieval resetting it', () => {
    const snapshot = parse([{ hex: 'abcdef', squawk: '7700', seen: 0, seen_pos: 0, lat: 1, lon: 2 }]);
    let records = reconcileEmergencies([], snapshot, now + 120_000);
    assert.equal(records[0]?.state, 'current');
    records = reconcileEmergencies(records, snapshot, now + 120_001);
    assert.equal(records[0]?.state, 'unknown');
    assert.equal(emergencyMarkerPosition(records[0]!, now + 120_001), undefined);
    assert.deepEqual(reconcileEmergencies(records, snapshot, now + EMERGENCY_RETENTION_MS + 1), []);
  });

  it('starts a new unknown receipt period after a complete empty response', () => {
    const snapshot = parse([{ hex: 'abcdef', squawk: '7500' }]);
    let records = reconcileEmergencies([], snapshot, now);
    const feeds = EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status: 'available', fetchedAt: now + 60_000, message: '' }));
    records = reconcileEmergencies(records, { observations: [], feeds }, now + 60_000);
    const reappeared = { ...snapshot, observations: snapshot.observations.map(report => ({ ...report, squawk: '7600' })) };
    records = reconcileEmergencies(records, reappeared, now + 120_000);
    assert.equal(records[0]?.retainedAt, now + 120_000);
    assert.equal(records[0]?.state, 'unknown');
    assert.equal(records[0]?.observations.length, 1);
    assert.equal(records[0]?.observations[0]?.squawk, '7600');
    records = reconcileEmergencies(records, reappeared, now + EMERGENCY_RETENTION_MS + 1);
    assert.equal(records.length, 1);
    assert.deepEqual(reconcileEmergencies(records, reappeared, now + 120_000 + EMERGENCY_RETENTION_MS + 1), []);
  });

  it('expires individual observations before deciding conflicts, including cached reports', () => {
    const fresh = parse([synthetic.ac[0]]).observations[0]!;
    const old = { ...fresh, source: 'synthetic-other-provider', squawk: '7700', observedAt: now - EMERGENCY_RETENTION_MS - 1 };
    let records = reconcileEmergencies([], { observations: [fresh, old], feeds: [] }, now - 1000);
    assert.equal(records[0]?.state, 'conflict', 'both reports are initially within retention');
    records = reconcileEmergencies(records, { observations: [fresh], feeds: [] }, now);
    assert.equal(records[0]?.state, 'current');
    assert.equal(records[0]?.observations.length, 1);
    assert.ok(emergencyMarkerPosition(records[0]!, now));
    records = reconcileEmergencies([], { observations: [fresh, old], feeds: [] }, now);
    assert.equal(records[0]?.state, 'current', 'an expired report arriving again cannot withhold the marker');
    assert.equal(records[0]?.observations.length, 1);
  });

  it('expires repeated undated conflicts even when another source stays fresh', () => {
    const fresh = parse([synthetic.ac[0]]).observations[0]!;
    const unknown = { ...fresh, source: 'synthetic-other-provider', squawk: '7700', observedAt: 0 };
    let records: EmergencyRecord[] = [];
    for (const offset of [0, EMERGENCY_RETENTION_MS, EMERGENCY_RETENTION_MS + 1, EMERGENCY_RETENTION_MS * 2]) {
      const time = now + offset;
      records = reconcileEmergencies(records, { observations: [{ ...fresh, observedAt: time, position: { lat: 1, lon: 2, observedAt: time } }, unknown], feeds: [] }, time);
      assert.equal(records[0]?.state, offset <= EMERGENCY_RETENTION_MS ? 'conflict' : 'current');
      assert.equal(records[0]?.observations.length, offset <= EMERGENCY_RETENTION_MS ? 2 : 1);
    }
  });

  it('deduplicates by address, keeps non-ICAO namespaces, and retains conflicting reports', () => {
    const row = synthetic.ac[0];
    const result = parse([row, { ...row }, { ...row, hex: `~${row.hex}` }]);
    assert.equal(reconcileEmergencies([], result, now).length, 2);
    const other = { ...result.observations[0]!, squawk: '7700', source: 'synthetic-other-provider' };
    const records = reconcileEmergencies([], { ...result, observations: [result.observations[0]!, other] }, now);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.state, 'conflict');
    assert.equal(records[0]?.observations.length, 2);
    const partial = reconcileEmergencies(records, { ...result, observations: [result.observations[0]!] }, now + 1000);
    assert.equal(partial[0]?.state, 'conflict', 'a missing report cannot settle conflicting evidence at the same clock');
    assert.equal(emergencyMarkerPosition(records[0]!, now), undefined);
    const positionConflict = reconcileEmergencies([], { ...result, observations: [result.observations[0]!, {
      ...result.observations[0]!, source: 'synthetic-other-provider',
      position: { ...result.observations[0]!.position!, lat: 20 },
    }] }, now);
    assert.equal(positionConflict[0]?.state, 'conflict');
    assert.equal(emergencyMarkerPosition(positionConflict[0]!, now), undefined);
  });

  it('handles code changes, out-of-order replies, missing reception, and finite retention', () => {
    const original = parse([synthetic.ac[0]]);
    let records = reconcileEmergencies([], original, now);
    const changed = parseEmergencyResponse({ now: now + 10_000, ac: [{ ...synthetic.ac[0], squawk: '7600' }] }, '7600', now + 10_000);
    records = reconcileEmergencies(records, changed, now + 10_000);
    assert.equal(records[0]?.observations[0]?.squawk, '7600');
    records = reconcileEmergencies(records, original, now + 11_000);
    assert.equal(records[0]?.observations[0]?.squawk, '7600');
    const ordinary = parse([{ ...synthetic.ac[0], squawk: '1200' }]);
    records = reconcileEmergencies(records, ordinary, now + 12_000);
    assert.equal(records[0]?.state, 'unknown');
    assert.equal(records[0]?.observations[0]?.squawk, '7600');
    assert.deepEqual(reconcileEmergencies(records, empty, now + 10_000 + EMERGENCY_RETENTION_MS + 1), []);
  });

  it('retains an undated code change as conflicting evidence until a newer timestamp orders it', () => {
    let records = reconcileEmergencies([], parse([synthetic.ac[0]]), now);
    const undated = parseEmergencyResponse({ now: now + 1000, ac: [{ hex: synthetic.ac[0].hex, squawk: '7600' }] }, '7600', now + 1000);
    records = reconcileEmergencies(records, undated, now + 1000);
    assert.equal(records[0]?.state, 'conflict');
    assert.deepEqual(new Set(records[0]?.observations.map(report => report.squawk)), new Set(['7500', '7600']));
    assert.equal(emergencyMarkerPosition(records[0]!, now + 1000), undefined);
    const ordered = parseEmergencyResponse({ now: now + 2000, ac: [{ ...synthetic.ac[0], squawk: '7600', seen: 0 }] }, '7600', now + 2000);
    records = reconcileEmergencies(records, ordered, now + 2000);
    assert.equal(records[0]?.state, 'current');
    assert.equal(records[0]?.observations.length, 1);
    assert.equal(records[0]?.observations[0]?.squawk, '7600');
  });

  it('rejects malformed and future-clock responses; stale responses are not successful current empties', () => {
    for (const body of [null, {}, { now, aircraft: [] }, { ac: [] }, { now: now + CLOCK_SKEW_TOLERANCE_MS + 1, ac: [] }]) {
      assert.throws(() => parseEmergencyResponse(body, '7500', now));
    }
    assert.equal(parseEmergencyResponse({ now: (now - 121_000) / 1000, ac: [] }, '7500', now).feeds[0]?.status, 'stale');
  });

  it('skips malformed rows and keeps the valid emergency reports beside them', () => {
    const rows = [null, 'row', { hex: 'unknown', squawk: '7500', seen: 0 }, { hex: '', squawk: '7500' }, { hex: 'not-hex-at-all', squawk: '1200' }, { hex: 'a00001', squawk: '7500', seen: 0 }];
    const snapshot = parseEmergencyResponse({ now, ac: rows }, '7500', now);
    assert.deepEqual(snapshot.observations.map(item => item.address), ['a00001']);
    assert.equal(snapshot.feeds[0]?.status, 'available');
  });

  it('tolerates small clock drift between provider, server, and browser', () => {
    // Provider 200 ms ahead of the server: accepted, and no report is dated after retrieval.
    const ahead = parseEmergencyResponse({ now: now + 200, ac: [{ hex: 'a00001', squawk: '7700', seen: 0.1, seen_pos: 0.1, lat: 1, lon: 1 }] }, '7700', now);
    assert.equal(ahead.feeds[0]?.status, 'available');
    assert.ok(ahead.observations[0]!.observedAt <= now);
    // Browser clock 5 s behind the server: the report is still current and on the map.
    const records = reconcileEmergencies([], ahead, now - 5_000);
    assert.equal(records[0]?.state, 'current');
    assert.ok(emergencyMarkerPosition(records[0]!, now - 5_000));
    assert.ok(!isFresh(now + CLOCK_SKEW_TOLERANCE_MS + 1, now, OBSERVATION_MAX_AGE_MS));
  });
});

describe('feed success, partial results, and failures', () => {
  it('retains successful empty slices separately from HTTP, schema, and network failures', async () => {
    globalThis.fetch = async input => {
      const code = String(input).split('/').at(-1);
      if (code === '7500') return Response.json({ now: Date.now(), ac: [] });
      if (code === '7600') return new Response('unavailable', { status: 503 });
      throw new Error('network unavailable');
    };
    const result = await fetchEmergencySnapshot();
    assert.deepEqual(result.feeds.map(feed => feed.status), ['available', 'unavailable', 'unavailable']);
    assert.deepEqual(result.observations, []);
    globalThis.fetch = async () => Response.json({ aircraft: [] });
    assert.ok((await fetchEmergencySnapshot()).feeds.every(feed => feed.status === 'unavailable'));
  });

  it('keeps a full outage out of the positive cache and serves it uncached', async () => {
    globalThis.fetch = async () => new Response('', { status: 503 });
    assert.equal(await fetchCacheableEmergencySnapshot(), null);
    const request = new Request('https://wm.test/api/aviation/v1/list-aircraft-emergencies');
    const result = await listAircraftEmergencies({ request } as Parameters<typeof listAircraftEmergencies>[0], {});
    assert.deepEqual(result.feeds.map(feed => feed.status), ['unavailable', 'unavailable', 'unavailable']);
    assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
    globalThis.fetch = async input => String(input).endsWith('/7500') ? Response.json({ now: Date.now(), ac: [] }) : new Response('', { status: 503 });
    assert.ok(await fetchCacheableEmergencySnapshot(), 'a partial result is still data');
  });

  it('keeps a fresh positive slice when another code query fails', async () => {
    globalThis.fetch = async input => String(input).endsWith('/7500')
      ? Response.json({ now: Date.now(), ac: [{ hex: 'a00001', squawk: '7500', seen: 0 }] })
      : new Response('', { status: 429 });
    const result = await fetchEmergencySnapshot();
    assert.equal(result.observations[0]?.squawk, '7500');
    assert.deepEqual(result.feeds.map(feed => feed.status), ['available', 'unavailable', 'unavailable']);
  });
});

// Elie's decision: a military aircraft squawking 7500/7600/7700 stays on the
// military layer, in clusters, theater posture and surge counts, and also
// appears on the emergency layer. Neither surface may drop it for the other.
describe('emergency-squawking military aircraft on both layers', () => {
  const militaryHexes = synthetic.ac.filter((row: { dbFlags: number }) => row.dbFlags === 1).map((row: { hex: string }) => row.hex);

  it('admits them to the military layer and also marks them on the emergency layer', () => {
    const states: unknown[][] = [];
    convertToStates(synthetic.ac, 'adsb.lol', new Set(), states, now);
    const result = filterMilitaryFlights(states);
    const admitted = new Map(result.flights.map((flight: { hexCode: string; squawk: string }) => [flight.hexCode.toLowerCase(), flight.squawk]));
    assert.deepEqual(militaryHexes.map((hex: string) => admitted.get(hex)), [...EMERGENCY_CODES]);
    assert.ok((result.byType.transport ?? 0) >= militaryHexes.length, 'emergency-squawking aircraft count toward the military totals');

    const records = reconcileEmergencies([], parse(), now);
    for (const hex of militaryHexes) {
      const record = records.find(row => row.address === hex);
      assert.equal(record?.observations[0]?.militaryFlag, 'set', hex);
      assert.ok(emergencyMarkerPosition(record!, now), `${hex} must also be on the emergency layer`);
    }
  });

  it('admits an aircraft seen only in an OpenSky state vector', () => {
    for (const squawk of EMERGENCY_CODES) {
      const state = ['ae0042', 'RCH042  ', 'United States', 0, 0, 45, 30, 10000, false, 400, 90, 0, null, 10000, squawk, false, 0];
      const { flights } = filterMilitaryFlights([state]);
      assert.deepEqual(flights.map((flight: { hexCode: string; squawk: string }) => [flight.hexCode, flight.squawk]), [['AE0042', squawk]]);
    }
  });

  it('counts them in theater posture and surge totals', () => {
    const flights = [...EMERGENCY_CODES, '1200'].map((squawk, index) => ({ id: String(index), squawk, lat: 1, lon: 1, aircraftType: 'fighter' }));
    const theaters = [{ id: 'test', name: 'Test', bounds: { south: 0, north: 2, west: 0, east: 2 }, thresholds: { elevated: 2, critical: 4 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 2 } }];
    const result = summarizeMilitaryTheaters(flights, theaters, now);
    assert.equal(result[0].totalFlights, 4);
    assert.equal(result[0].fighters, 4);
  });
});

// One definition of the emergency codes. TS, ESM and CommonJS consumers all
// import shared/aircraft-emergencies.ts (Node 24 strips the types), so a copy
// of the list anywhere else is drift waiting to happen.
describe('EMERGENCY_CODES single source', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const triple = /['"]7500['"]\s*,\s*['"]7600['"]\s*,\s*['"]7700['"]/;

  it('loads the same codes from CommonJS', () => {
    const required = createRequire(import.meta.url)('../shared/aircraft-emergencies.ts') as { EMERGENCY_CODES: readonly string[] };
    assert.deepEqual([...required.EMERGENCY_CODES], [...EMERGENCY_CODES]);
  });

  it('is not duplicated as a literal list in code', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'generated' || name === 'fixtures' || name.startsWith('.git')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:[cm]?[jt]s|tsx)$/.test(name) && triple.test(readFileSync(path, 'utf8'))) offenders.push(relative(root, path));
      }
    };
    for (const dir of ['shared', 'server', 'src', 'scripts', 'api', 'tests', '.agents']) walk(join(root, dir));
    assert.deepEqual(offenders, ['shared/aircraft-emergencies.ts']);
  });
});
