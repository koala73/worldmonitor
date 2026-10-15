import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { parseEmergencyResponse } from '../server/worldmonitor/aviation/v1/aircraft-emergency-source';
import { fetchEmergencySnapshot } from '../server/worldmonitor/aviation/v1/list-aircraft-emergencies';
import {
  EMERGENCY_CODES, EMERGENCY_RETENTION_MS, emergencyMarkerPosition, isEmergencySquawk,
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

  it('rejects malformed and future-clock responses; stale responses are not successful current empties', () => {
    for (const body of [null, {}, { now, aircraft: [] }, { ac: [] }, { now: now + 1, ac: [] }, { now, ac: [null] }, { now, ac: [{ hex: 'unknown', squawk: '7500' }] }]) {
      assert.throws(() => parseEmergencyResponse(body, '7500', now));
    }
    assert.equal(parseEmergencyResponse({ now: (now - 121_000) / 1000, ac: [] }, '7500', now).feeds[0]?.status, 'stale');
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

  it('keeps a fresh positive slice when another code query fails', async () => {
    globalThis.fetch = async input => String(input).endsWith('/7500')
      ? Response.json({ now: Date.now(), ac: [{ hex: 'a00001', squawk: '7500', seen: 0 }] })
      : new Response('', { status: 429 });
    const result = await fetchEmergencySnapshot();
    assert.equal(result.observations[0]?.squawk, '7500');
    assert.deepEqual(result.feeds.map(feed => feed.status), ['available', 'unavailable', 'unavailable']);
  });
});

describe('military admission and posture', () => {
  it('excludes all emergency codes before military classification and totals', () => {
    const states: unknown[][] = [];
    convertToStates(synthetic.ac, 'adsb.lol', new Set(), states, now);
    assert.equal(states.length, 6);
    const result = filterMilitaryFlights(states);
    assert.deepEqual(result.flights, []);
    assert.deepEqual(result.byType, {});
  });

  it('does not add emergency aircraft to theater posture counts', () => {
    const flights = [...EMERGENCY_CODES, '1200'].map((squawk, index) => ({ id: String(index), squawk, lat: 1, lon: 1, aircraftType: 'fighter' }));
    const theaters = [{ id: 'test', name: 'Test', bounds: { south: 0, north: 2, west: 0, east: 2 }, thresholds: { elevated: 2, critical: 4 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 2 } }];
    const result = summarizeMilitaryTheaters(flights, theaters, now);
    assert.equal(result[0].totalFlights, 1);
    assert.equal(result[0].fighters, 1);
  });
});
