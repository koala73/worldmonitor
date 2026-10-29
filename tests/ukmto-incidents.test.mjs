import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeIncidents, fetchUkmtoIncidents, seedOptions } from '../scripts/seed-ukmto-incidents.mjs';

// A trimmed capture of https://hormuz.data-tracking.net/api/incidents (2026-10-29), in its exact wire shape.
const captured = JSON.parse(readFileSync(new URL('./fixtures/hormuz-ukmto-incidents.json', import.meta.url), 'utf8'));
const COLUMNS = ['id', 'type', 'lat', 'lon', 'ts', 'vessel_type', 'place', 'fire', 'sunk', 'abandoned', 'casualty', 'time_late', 'text'];
const report = {
  id: 'UKMTO-143', type: 'Suspicious Activity', lat: 26.43, lon: 56.48, ts: 1790636400, vessel_type: 'Tanker',
  place: 'Strait of Hormuz', fire: 1, sunk: 0, abandoned: 0, casualty: 0, time_late: 1,
  text: 'A vessel was struck by a suspected projectile. Authorities are investigating.',
};

// Encodes rows the way the publisher does: string columns hold indexes into a shared string table.
function table(rows, overrides = {}) {
  const strings = [];
  const textColumns = [0, 1, 5, 6, 12];
  const r = rows.map(row => COLUMNS.map((column, i) => {
    if (!textColumns.includes(i)) return row[column];
    strings.push(row[column]);
    return strings.length - 1;
  }));
  return { v: 1, built: 1793300531, t: { c: COLUMNS, k: textColumns, r }, vessels: [], s: strings, ...overrides };
}

test('decodes the captured publisher table and keeps one entry per incident', () => {
  const incidents = normalizeIncidents(captured);
  assert.deepEqual(incidents.map(item => item.incidentNumber), [186, 179, 165, 143, 78]);
  const ukmto143 = incidents.find(item => item.incidentNumber === 143);
  // Matches UKMTO's own record for incident 143 (utcDateOfIncident 2026-09-28T23:00:00Z).
  assert.equal(ukmto143.id, 'ukmto-143');
  assert.equal(ukmto143.occurredAt, Date.parse('2026-09-28T23:00:00Z'));
  assert.equal(ukmto143.incidentType, 'Suspicious Activity');
  assert.equal(ukmto143.place, 'Strait of Hormuz');
  assert.deepEqual(ukmto143.location, { latitude: 26.433333333333334, longitude: 56.486111111111114 });
  assert.match(ukmto143.description, /^UKMTO has received/);
});

test('folds a repeated report at the same time and position into its UKMTO number', () => {
  const repeat = { ...report, id: 'UKMTO-28082035', text: 'UKMTO WARNING 143-26 - repeated record.' };
  assert.deepEqual(normalizeIncidents(table([repeat, report])).map(item => item.id), ['ukmto-143']);
  const moved = { ...repeat, lat: 25 };
  assert.equal(normalizeIncidents(table([moved, report])).length, 2);
});

test('leaves the publication time unset because the source does not carry it', () => {
  const [item] = normalizeIncidents(table([report]));
  assert.equal(item.reportedAt, 0);
  assert.equal('severity' in item, false);
});

test('deduplicates identical reports but rejects conflicting identities', () => {
  assert.equal(normalizeIncidents(table([report, report])).length, 1);
  assert.throws(() => normalizeIncidents(table([report, { ...report, text: 'Changed' }])));
  assert.equal(normalizeIncidents(table([{ ...report, text: 'Changed' }]))[0].description, 'Changed');
});

test('accepts a valid empty snapshot and unknown incident types', () => {
  assert.deepEqual(normalizeIncidents(table([])), []);
  assert.equal(normalizeIncidents(table([{ ...report, type: 'New classification' }]))[0].incidentType, 'New classification');
  assert.equal(seedOptions.validateFn({ incidents: [], fetchedAt: Date.now() }), true);
});

test('never publishes a snapshot whose incident dates its reader would reject', () => {
  const [incident] = normalizeIncidents(table([report]));
  assert.equal(seedOptions.validateFn({ incidents: [incident], fetchedAt: Date.now() }), true);
  for (const occurredAt of [8640000000001000, 1e308, Infinity, 0, -1, '1790636400000']) {
    assert.equal(seedOptions.validateFn({ incidents: [{ ...incident, occurredAt }], fetchedAt: Date.now() }), false, String(occurredAt));
  }
});

test('rejects malformed snapshots without manufacturing positions or dates', () => {
  const valid = table([report]);
  for (const value of [
    null, {}, [], { ...valid, v: 2 }, { ...valid, t: null }, { ...valid, s: null },
    { ...valid, t: { ...valid.t, c: COLUMNS.filter(column => column !== 'ts') } },
    { ...valid, t: { ...valid.t, r: [valid.t.r[0].slice(0, -1)] } },
    { ...valid, t: { ...valid.t, r: [[99, ...valid.t.r[0].slice(1)]] } },
    table([{ ...report, id: '143' }]), table([{ ...report, id: 'UKMTO-0' }]),
    table([{ ...report, lat: null }]), table([{ ...report, lon: 181 }]),
    table([{ ...report, ts: 1790636400.5 }]), table([{ ...report, ts: 0 }]),
    // Seconds whose millisecond value is not a representable Date would publish a snapshot the reader rejects.
    table([{ ...report, ts: 8640000000001 }]), table([{ ...report, ts: 1793300400000000 }]), table([{ ...report, ts: 1e308 }]),
    table([{ ...report, type: ' ' }]), table([{ ...report, text: 'x'.repeat(20001) }]),
  ]) {
    assert.throws(() => normalizeIncidents(value));
  }
});

test('fetch uses a bounded request to the documented endpoint and rejects upstream failure', async () => {
  const context = { runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 };
  const snapshot = await fetchUkmtoIncidents(context, async (url, options) => {
    assert.equal(url, 'https://hormuz.data-tracking.net/api/incidents');
    assert.ok(options.headers['User-Agent']);
    assert.ok(options.signal);
    return new Response(JSON.stringify(captured));
  });
  assert.equal(snapshot.incidents.length, 5);
  assert.ok(snapshot.fetchedAt > 0);
  await assert.rejects(fetchUkmtoIncidents(context, async () => new Response('', { status: 403 })), /UKMTO source HTTP 403/);
  await assert.rejects(fetchUkmtoIncidents(context, async () => new Response('', { status: 503 })));
  await assert.rejects(fetchUkmtoIncidents(context, async () => { throw new Error('timeout'); }));
});

test('access and schema failures wait for the next run instead of retrying immediately', async () => {
  const context = { runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 };
  const failure = async (response) => fetchUkmtoIncidents(context, async () => response).catch(error => error);
  assert.equal((await failure(new Response('', { status: 403 }))).nonRetryable, true);
  assert.equal((await failure(new Response(JSON.stringify(table([{ ...report, place: null }]))))).nonRetryable, true);
  assert.equal((await failure(new Response('{"truncated'))).nonRetryable, true);
  assert.equal((await failure(new Response('', { status: 408 }))).nonRetryable, undefined);
  assert.equal((await failure(new Response('', { status: 429 }))).nonRetryable, undefined);
  assert.equal((await failure(new Response('', { status: 503 }))).nonRetryable, undefined);
  const interrupted = new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket reset')); } }));
  assert.equal((await failure(interrupted)).nonRetryable, undefined);
});

test('orders reports newest first with a stable tie-break and caps the snapshot', () => {
  const older = { ...report, id: 'UKMTO-100', ts: report.ts - 86400, lat: 20 };
  const tie = { ...report, id: 'UKMTO-142', lat: 21 };
  assert.deepEqual(normalizeIncidents(table([older, report, tie])).map(item => item.id), ['ukmto-142', 'ukmto-143', 'ukmto-100']);
  assert.throws(() => normalizeIncidents(table(Array.from({ length: 2001 }, (_, i) => ({ ...report, id: `UKMTO-${i + 1}`, lat: i / 100 })))));
});

test('polls no faster than the publisher refreshes and stays fresh between runs', () => {
  assert.equal(seedOptions.maxStaleMin, 75);
  assert.equal(seedOptions.ttlSeconds, 86400);
});

test('marks the producer active only after a publish with Redis credentials', async () => {
  const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, fetch: globalThis.fetch };
  const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ result: 'OK' })); };
  try {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await seedOptions.afterPublish();
    assert.equal(calls.length, 0);
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    await seedOptions.afterPublish();
    assert.deepEqual(calls, [['SET', 'seed-activated:maritime:ukmto-incidents', '1']]);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [name, value] of [['UPSTASH_REDIS_REST_URL', saved.url], ['UPSTASH_REDIS_REST_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
