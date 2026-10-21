import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  GTA_FIRE_ID_NS,
  GTA_FIRE_KEY,
  GTA_POLICE_ID_NS,
  GTA_POLICE_KEY,
  GTA_SEMANTIC,
  GTA_UPDATE_ABOUT_URL,
  GTA_UPDATE_HOST,
  GTA_UPDATE_LAST_INGEST_URL,
  GTA_UPDATE_PRODUCTION_ENABLED,
  GTA_UPDATE_RIGHTS_STATUS,
  GTA_UPDATE_SITE_URL,
  GTA_UPDATE_WRITER_ENABLED,
  classifyGtaDescription,
  declareGtaRecords,
  fetchGtaSnapshot,
  fireCanonicalId,
  gtaFireSnapshotUrl,
  gtaPoliceSnapshotUrl,
  gtaUpdateContentMeta,
  isFireNamespaceId,
  isPoliceNamespaceId,
  parseGtaFireSnapshot,
  parseGtaLastIngest,
  parseGtaPoliceSnapshot,
  policeCanonicalId,
  refuseGtaProductionWrite,
  resolveGtaPublish,
  validateGtaSnapshot,
} from '../scripts/lib/gta-update.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policeFixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/gta-update-police.json'), 'utf8'));
const fireFixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/gta-update-fire.json'), 'utf8'));
const lastIngestText = readFileSync(join(root, 'tests/fixtures/gta-update-last-ingest.txt'), 'utf8');

function jsonResponse(body, { status = 200 } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
}

describe('GTA Update parser contract (#7012)', () => {
  it('keeps useful police rows and separate police IDs', () => {
    const { records, dropped } = parseGtaPoliceSnapshot(policeFixture);
    assert.deepEqual(records.map((row) => row.id).sort(), ['gta-police:1001', 'gta-police:1008']);
    assert.equal(records.every((row) => isPoliceNamespaceId(row.id)), true);
    assert.equal(records.every((row) => row.semantic === GTA_SEMANTIC), true);
    assert.equal(records.every((row) => row.lat == null && row.lon == null && row.geocoded === false), true);
    assert.equal(records.find((row) => row.id === 'gta-police:1001').location, 'Kingsbury Crescent / Kingston Road');
    assert.equal(dropped.some((row) => row.reason === 'missing_id'), true);
  });

  it('keeps useful fire rows and a separate fire ID namespace', () => {
    const { records, dropped } = parseGtaFireSnapshot(fireFixture);
    assert.deepEqual(records.map((row) => row.id).sort(), ['gta-fire:F26129800', 'gta-fire:F26129823']);
    assert.equal(records.every((row) => isFireNamespaceId(row.id)), true);
    assert.equal(policeCanonicalId(17238425), 'gta-police:17238425');
    assert.equal(fireCanonicalId('F26129823'), 'gta-fire:F26129823');
    assert.notEqual(GTA_POLICE_ID_NS, GTA_FIRE_ID_NS);
    assert.equal(dropped.some((row) => row.reason === 'missing_id'), true);
  });

  it('denies medical, suicide/PIC, sexual violence, and domestic violence', () => {
    assert.equal(classifyGtaDescription('See Ambulance').reason, 'medical');
    assert.equal(classifyGtaDescription('Medical').reason, 'medical');
    assert.equal(classifyGtaDescription('Person In Crisis').reason, 'suicide_pic');
    assert.equal(classifyGtaDescription('Suicide Attempt').reason, 'suicide_pic');
    assert.equal(classifyGtaDescription('Sexual Assault').reason, 'sexual_violence');
    assert.equal(classifyGtaDescription('Domestic Assault').reason, 'domestic_violence');
    const { dropped: policeDropped } = parseGtaPoliceSnapshot(policeFixture);
    const reasons = new Set(policeDropped.map((row) => row.reason));
    assert.ok(reasons.has('medical'));
    assert.ok(reasons.has('suicide_pic'));
    assert.ok(reasons.has('sexual_violence'));
    assert.ok(reasons.has('domestic_violence'));
    const { dropped: fireDropped } = parseGtaFireSnapshot(fireFixture);
    assert.ok(fireDropped.some((row) => row.reason === 'medical'));
  });

  it('drops cancelled and reclassified rows', () => {
    const { records, dropped } = parseGtaPoliceSnapshot(policeFixture);
    assert.equal(records.some((row) => /cancel|reclass/i.test(row.description)), false);
    const reasons = dropped.map((row) => row.reason);
    assert.ok(reasons.includes('cancelled'));
    assert.ok(reasons.includes('reclassified'));
    const fire = parseGtaFireSnapshot(fireFixture);
    assert.ok(fire.dropped.some((row) => row.reason === 'cancelled'));
  });

  it('does not geocode location strings', () => {
    const { records } = parseGtaPoliceSnapshot(policeFixture);
    for (const row of records) {
      assert.equal(row.geocoded, false);
      assert.equal(row.lat, null);
      assert.equal(row.lon, null);
      assert.equal(typeof row.location, 'string');
    }
  });

  it('health uses last_ingest publisher time, not fetch time', () => {
    const parsed = parseGtaLastIngest(lastIngestText);
    assert.equal(parsed.raw, '2026-08-20 17:50:02');
    assert.equal(parsed.publisherTime, '2026-08-20T17:50:02Z');
    assert.equal(parsed.publisherTimeMs, Date.UTC(2026, 7, 20, 17, 50, 2));
    const snapshot = {
      schemaVersion: 1,
      semantic: GTA_SEMANTIC,
      source: 'gta-update-police',
      official: false,
      verified: false,
      writerEnabled: false,
      publisherTimeMs: parsed.publisherTimeMs,
      fetchedAt: '2026-08-21T00:00:00.000Z',
      records: [],
    };
    const meta = gtaUpdateContentMeta(snapshot);
    assert.equal(meta.newestItemAt, parsed.publisherTimeMs);
    assert.notEqual(meta.newestItemAt, Date.parse(snapshot.fetchedAt));
  });

  it('keeps last-good when a peer fetch fails', () => {
    const { records } = parseGtaPoliceSnapshot(policeFixture);
    const lastGood = {
      schemaVersion: 1,
      semantic: GTA_SEMANTIC,
      source: 'gta-update-police',
      official: false,
      verified: false,
      writerEnabled: false,
      records,
    };
    assert.equal(validateGtaSnapshot(lastGood, 'police'), true);
    const decision = resolveGtaPublish({ ok: false, reason: 'http_503' }, lastGood);
    assert.equal(decision.persist, false);
    assert.equal(decision.keepLastGood, true);
    assert.equal(decision.sourceState, 'degraded');
    const empty = resolveGtaPublish({ ok: false, reason: 'http_503' }, null);
    assert.equal(empty.keepLastGood, false);
    assert.equal(empty.sourceState, 'unavailable');
  });

  it('fails closed on 4xx/5xx, malformed JSON, and timeout', async () => {
    const http503 = await fetchGtaSnapshot('police', {
      fetchImpl: async () => jsonResponse({ error: 'no' }, { status: 503 }),
    });
    assert.equal(http503.ok, false);
    assert.equal(http503.reason, 'http_503');

    const malformed = await fetchGtaSnapshot('police', {
      fetchImpl: async () => jsonResponse('<html>not json</html>'),
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.reason, 'shape_break');

    const timedOut = await fetchGtaSnapshot('fire', {
      fetchImpl: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.reason, 'timeout');
  });

  it('refuses the production writer', () => {
    assert.equal(GTA_UPDATE_WRITER_ENABLED, false);
    assert.equal(GTA_UPDATE_PRODUCTION_ENABLED, false);
    assert.equal(GTA_UPDATE_RIGHTS_STATUS, 'permission-held');
    assert.throws(() => refuseGtaProductionWrite(), /disabled/);
    assert.equal(declareGtaRecords({ records: [] }), 0);
    assert.match(GTA_UPDATE_SITE_URL, /gtaupdate\.com/);
    assert.match(GTA_UPDATE_ABOUT_URL, /about\.php/);
    assert.match(GTA_UPDATE_LAST_INGEST_URL, /last_ingest\.txt/);
    assert.equal(gtaPoliceSnapshotUrl(1), `https://${GTA_UPDATE_HOST}/cache/gta_police_1.json`);
    assert.equal(gtaFireSnapshotUrl(6), `https://${GTA_UPDATE_HOST}/cache/gta_fire_6.json`);
    assert.equal(GTA_POLICE_KEY, 'safety:toronto:gta-update:police:v1');
    assert.equal(GTA_FIRE_KEY, 'safety:toronto:gta-update:fire:v1');
  });
});
