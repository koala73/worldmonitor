import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeIncidents, fetchUkmtoIncidents, seedOptions } from '../scripts/seed-ukmto-incidents.mjs';

const report = {
  sitecoreId: 'a5b33f9d-6c8e-43fc-9af0-3936d61bf55d', incidentIssuer: 'UKMTO', incidentNumber: 143,
  utcDateCreated: '2026-09-29T10:28:14Z', utcDateOfIncident: '2026-09-28T23:00:00Z',
  incidentTypeName: 'Suspicious Activity', pinColour: 'Yellow',
  locationLatitude: 26.43, locationLongitude: 56.48, place: 'Strait of Hormuz',
  otherDetails: 'A vessel was struck by a suspected projectile. Authorities are investigating.',
};

test('preserves source identity, claim language and separate report clocks', () => {
  const [item] = normalizeIncidents([report]);
  assert.equal(item.id, report.sitecoreId);
  assert.equal(item.description, report.otherDetails);
  assert.equal(item.occurredAt, Date.parse(report.utcDateOfIncident));
  assert.equal(item.reportedAt, Date.parse(report.utcDateCreated));
  assert.equal(item.incidentType, 'Suspicious Activity');
  assert.equal('severity' in item, false);
  assert.deepEqual(item.location, { latitude: 26.43, longitude: 56.48 });
});

test('deduplicates identical reports but rejects conflicting identities', () => {
  assert.equal(normalizeIncidents([report, report]).length, 1);
  assert.throws(() => normalizeIncidents([report, { ...report, otherDetails: 'Changed' }]));
  assert.equal(normalizeIncidents([{ ...report, otherDetails: 'Changed' }])[0].description, 'Changed');
});

test('accepts a valid empty snapshot and unknown incident types', () => {
  assert.deepEqual(normalizeIncidents([]), []);
  assert.equal(normalizeIncidents([{ ...report, incidentTypeName: 'New classification' }])[0].incidentType, 'New classification');
  assert.equal(seedOptions.validateFn({ incidents: [], fetchedAt: Date.now() }), true);
});

test('rejects malformed snapshots without manufacturing positions or dates', () => {
  for (const value of [null, {}, [null], [{ ...report, locationLatitude: null }],
    [{ ...report, locationLongitude: 181 }], [{ ...report, utcDateCreated: '' }],
    [{ ...report, utcDateCreated: '2026-02-30T10:00:00Z' }],
    [{ ...report, utcDateOfIncident: '2026-10-29T24:00:00Z' }],
    [{ ...report, utcDateCreated: '10/29/2026' }],
    [{ ...report, sitecoreId: '' }], [{ ...report, otherDetails: null }]]) {
    assert.throws(() => normalizeIncidents(value));
  }
});

test('fetch uses a bounded request and rejects upstream failure', async () => {
  const snapshot = await fetchUkmtoIncidents({ runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 }, async (url, options) => {
    assert.equal(new URL(url).hostname, 'sccd.royalnavy.mod.uk');
    assert.ok(options.headers['User-Agent']);
    assert.ok(options.signal);
    return new Response(JSON.stringify([report]));
  });
  assert.equal(snapshot.incidents.length, 1);
  assert.ok(snapshot.fetchedAt > 0);
  await assert.rejects(fetchUkmtoIncidents({ runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 }, async () => new Response('', { status: 403 })), /UKMTO HTTP 403/);
  await assert.rejects(fetchUkmtoIncidents({ runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 }, async () => new Response('', { status: 503 })));
  await assert.rejects(fetchUkmtoIncidents({ runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 }, async () => { throw new Error('timeout'); }));
});

test('access and schema failures wait for the next run instead of retrying immediately', async () => {
  const context = { runStartedAtMs: Date.now(), fetchDeadlineAtMs: Date.now() + 30000 };
  const failure = async (response) => fetchUkmtoIncidents(context, async () => response).catch(error => error);
  assert.equal((await failure(new Response('', { status: 403 }))).nonRetryable, true);
  assert.equal((await failure(new Response(JSON.stringify([{ ...report, place: null }])))).nonRetryable, true);
  assert.equal((await failure(new Response('{"truncated'))).nonRetryable, true);
  assert.equal((await failure(new Response('', { status: 408 }))).nonRetryable, undefined);
  assert.equal((await failure(new Response('', { status: 429 }))).nonRetryable, undefined);
  assert.equal((await failure(new Response('', { status: 503 }))).nonRetryable, undefined);
  const interrupted = new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket reset')); } }));
  assert.equal((await failure(interrupted)).nonRetryable, undefined);
});

test('orders reports newest first with a stable tie-break and caps the snapshot', () => {
  const older = { ...report, sitecoreId: 'b5b33f9d-6c8e-43fc-9af0-3936d61bf55d', utcDateOfIncident: '2026-09-01T00:00:00Z' };
  const tie = { ...report, sitecoreId: '05b33f9d-6c8e-43fc-9af0-3936d61bf55d' };
  assert.deepEqual(normalizeIncidents([older, report, tie]).map(item => item.id), [tie.sitecoreId, report.sitecoreId, older.sitecoreId]);
  assert.throws(() => normalizeIncidents(Array.from({ length: 2001 }, () => report)));
  assert.throws(() => normalizeIncidents([{ ...report, otherDetails: 'x'.repeat(20001) }]));
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
