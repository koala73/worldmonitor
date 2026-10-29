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
