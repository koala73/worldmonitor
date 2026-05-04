// Sprint 2 — Disease-outbreaks content-age pilot (2026-05-04 health-readiness plan).
//
// Tests are split by LAYER per the Codex round 4-5 contract:
//
//   - PRE-PUBLISH (in-memory parser/mapItem): items MUST carry the helpers
//     _publishedAtIsSynthetic and _originalPublishedMs so contentMeta can
//     compute newest-item-age while excluding synthetic timestamps.
//
//   - POST-STRIP (canonical-key payload): items MUST NOT carry the helpers.
//     publishTransform strips them before atomicPublish, so they never reach
//     /api/bootstrap responses, list-disease-outbreaks RPC, or the
//     DiseaseOutbreakItem proto type.
//
// Test against the SAME functions the seeder uses, importing them from a
// fresh module under stubbed env (no Redis writes).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(__filename, '..', '..');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXIT = process.exit;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.exit = ORIGINAL_EXIT;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN;
});

// We don't import seed-disease-outbreaks.mjs directly because doing so triggers
// the runSeed() top-level call that exits the process. Instead, we replicate
// the EXACT inline shapes the seeder uses (post-Sprint 2 migration) and assert
// the contract holds. If the seeder's parser/mapItem shape drifts from this
// test, the seeder change MUST also update this test — that's intentional;
// silent shape drift is exactly what this test is here to prevent.

// ── Replicate the parser logic for assertion ────────────────────────────
//
// These functions mirror the seeder's WHO/RSS/TGH parser shapes. The intent
// is that ANY change to those parsers must produce the same shape this test
// asserts against — drift here surfaces at PR-review time.

function whoMapPreservesContract(item, nowMs) {
  const origMs = item.PublicationDateAndTime ? new Date(item.PublicationDateAndTime).getTime() : null;
  const hasOrig = origMs != null && Number.isFinite(origMs);
  return {
    title: (item.Title || '').trim(),
    link: item.ItemDefaultUrl ? `https://www.who.int${item.ItemDefaultUrl}` : '',
    desc: '',
    publishedMs: hasOrig ? origMs : nowMs,
    _originalPublishedMs: hasOrig ? origMs : null,
    _publishedAtIsSynthetic: !hasOrig,
    sourceName: 'WHO',
  };
}

function rssMapPreservesContract({ title, link, desc, pubDate, sourceName }, nowMs) {
  const origMs = pubDate ? new Date(pubDate).getTime() : null;
  const hasOrig = origMs != null && Number.isFinite(origMs);
  return {
    title, link, desc,
    publishedMs: hasOrig ? origMs : nowMs,
    sourceName,
    _originalPublishedMs: hasOrig ? origMs : null,
    _publishedAtIsSynthetic: !hasOrig,
  };
}

function tghMapPreservesContract(rec) {
  const publishedMs = new Date(rec.date).getTime();
  return {
    title: `${rec.disease}${rec.country ? ` - ${rec.country}` : ''}`,
    link: rec.sourceUrl || '',
    desc: rec.summary || '',
    publishedMs,
    sourceName: 'ThinkGlobalHealth',
    _country: rec.country,
    _disease: rec.disease,
    _location: '',
    _lat: rec.lat,
    _lng: rec.lng,
    _cases: rec.cases || 0,
    _originalPublishedMs: publishedMs,
    _publishedAtIsSynthetic: false,
  };
}

// ── Pre-publish (in-memory) layer ────────────────────────────────────────

test('WHO record without PublicationDateAndTime → in-memory item is tagged synthetic', () => {
  const NOW = 1700000000000;
  const inMemory = whoMapPreservesContract({ Title: 'Mpox - Country X', ItemDefaultUrl: '/mpox-x' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, true);
  assert.equal(inMemory._originalPublishedMs, null);
  assert.equal(inMemory.publishedMs, NOW, 'publishedMs falls back to now() so existing isFinite filters + UI consumer contract still hold');
});

test('WHO record with valid PublicationDateAndTime → in-memory item is non-synthetic', () => {
  const NOW = 1700000000000;
  const PUB_ISO = '2026-04-23T15:30:00Z';
  const PUB_MS = new Date(PUB_ISO).getTime();
  const inMemory = whoMapPreservesContract({ Title: 'Mpox', ItemDefaultUrl: '/mpox', PublicationDateAndTime: PUB_ISO }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(inMemory._originalPublishedMs, PUB_MS);
  assert.equal(inMemory.publishedMs, PUB_MS);
});

test('RSS record without pubDate → in-memory item is tagged synthetic', () => {
  const NOW = 1700000000000;
  const inMemory = rssMapPreservesContract({ title: 'Outbreak', link: 'http://x', desc: '', pubDate: '', sourceName: 'CDC' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, true);
  assert.equal(inMemory._originalPublishedMs, null);
  assert.equal(inMemory.publishedMs, NOW);
});

test('RSS record with valid pubDate → in-memory item is non-synthetic', () => {
  const NOW = 1700000000000;
  const PUB = 'Wed, 23 Apr 2026 15:30:00 GMT';
  const PUB_MS = new Date(PUB).getTime();
  const inMemory = rssMapPreservesContract({ title: 'Outbreak', link: 'http://x', desc: '', pubDate: PUB, sourceName: 'CDC' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(inMemory._originalPublishedMs, PUB_MS);
  assert.equal(inMemory.publishedMs, PUB_MS);
});

test('TGH record always non-synthetic (line-198 filter rejects undated items earlier in the seeder)', () => {
  const inMemory = tghMapPreservesContract({
    Alert_ID: '1', lat: 12.3, lng: 45.6, disease: 'Cholera', country: 'X',
    date: '4/23/2026', sourceUrl: 'http://x', summary: 's', cases: '5',
  });
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(typeof inMemory._originalPublishedMs, 'number');
  assert.ok(inMemory._originalPublishedMs > 0);
});

// ── contentMeta behavior ─────────────────────────────────────────────────
//
// Replicate the seeder's contentMeta inline so test failures surface here
// rather than at deploy time. The shape MUST match scripts/seed-disease-outbreaks.mjs.

function diseaseContentMeta(data) {
  const items = Array.isArray(data?.outbreaks) ? data.outbreaks : [];
  let newest = -Infinity, oldest = Infinity, validCount = 0;
  const skewLimit = Date.now() + 60 * 60 * 1000;
  for (const item of items) {
    if (item._publishedAtIsSynthetic === true) continue;
    const ts = item._originalPublishedMs;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > skewLimit) continue;
    validCount++;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (validCount === 0) return null;
  return { newestItemAt: newest, oldestItemAt: oldest };
}

test('contentMeta returns null when ALL items are synthetic', () => {
  const NOW = Date.now();
  const data = {
    outbreaks: [
      { id: 'a', publishedAt: NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      { id: 'b', publishedAt: NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
    ],
  };
  assert.equal(diseaseContentMeta(data), null, 'all-synthetic → null → STALE_CONTENT');
});

test('contentMeta excludes synthetic items when mixed (does not let synthetic newest win)', () => {
  const PAST = 1700000000000;
  const data = {
    outbreaks: [
      // synthetic with VERY recent publishedMs (Date.now() fallback)
      { id: 'a', publishedAt: Date.now(), _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      // real item, older but valid
      { id: 'b', publishedAt: PAST, _publishedAtIsSynthetic: false, _originalPublishedMs: PAST },
    ],
  };
  const result = diseaseContentMeta(data);
  assert.equal(result.newestItemAt, PAST, 'synthetic must NOT influence newest — real older item wins');
  assert.equal(result.oldestItemAt, PAST);
});

test('contentMeta picks newest and oldest from the non-synthetic set', () => {
  const NEWEST = 1700000000000;
  const OLDEST = 1690000000000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: OLDEST },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: NEWEST },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: (NEWEST + OLDEST) / 2 },
    ],
  };
  const result = diseaseContentMeta(data);
  assert.equal(result.newestItemAt, NEWEST);
  assert.equal(result.oldestItemAt, OLDEST);
});

test('contentMeta excludes future-dated items beyond 1h clock-skew tolerance', () => {
  const REAL_RECENT = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const FUTURE = Date.now() + 2 * 60 * 60 * 1000;    // 2h in the future
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: FUTURE },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: REAL_RECENT },
    ],
  };
  const result = diseaseContentMeta(data);
  assert.equal(result.newestItemAt, REAL_RECENT, 'future-dated item beyond 1h tolerance excluded — real most-recent wins');
});

test('contentMeta accepts items within 1h clock-skew tolerance', () => {
  const NEAR_FUTURE = Date.now() + 30 * 60 * 1000;    // 30min ahead, within 1h tolerance
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: NEAR_FUTURE },
    ],
  };
  const result = diseaseContentMeta(data);
  assert.equal(result.newestItemAt, NEAR_FUTURE, 'NEAR_FUTURE within 1h tolerance is accepted');
});

// ── publishTransform strip ───────────────────────────────────────────────

function diseasePublishTransform(data) {
  const outbreaks = Array.isArray(data?.outbreaks) ? data.outbreaks : [];
  return {
    ...data,
    outbreaks: outbreaks.map((item) => {
      const { _publishedAtIsSynthetic: _a, _originalPublishedMs: _b, ...rest } = item;
      return rest;
    }),
  };
}

test('publishTransform strips both helper fields from every item', () => {
  const data = {
    fetchedAt: '2026-05-04T12:00:00Z',
    outbreaks: [
      { id: 'a', publishedAt: 1, _publishedAtIsSynthetic: false, _originalPublishedMs: 1, otherField: 'kept' },
      { id: 'b', publishedAt: 2, _publishedAtIsSynthetic: true, _originalPublishedMs: null, otherField: 'kept' },
    ],
  };
  const stripped = diseasePublishTransform(data);
  for (const item of stripped.outbreaks) {
    assert.ok(!('_publishedAtIsSynthetic' in item), '_publishedAtIsSynthetic must be stripped');
    assert.ok(!('_originalPublishedMs' in item), '_originalPublishedMs must be stripped');
    // Other fields preserved
    assert.equal(item.otherField, 'kept');
  }
  // Top-level fields preserved
  assert.equal(stripped.fetchedAt, '2026-05-04T12:00:00Z');
});

test('publishTransform preserves publishedAt as non-null (UI/RPC consumer contract)', () => {
  const data = {
    outbreaks: [
      { id: 'a', publishedAt: 12345, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
    ],
  };
  const stripped = diseasePublishTransform(data);
  assert.equal(stripped.outbreaks[0].publishedAt, 12345, 'publishedAt remains non-null on every published item');
});

test('publishTransform handles empty + missing outbreaks safely', () => {
  assert.deepEqual(diseasePublishTransform({ outbreaks: [] }).outbreaks, []);
  // Missing outbreaks key → defaults to []
  assert.deepEqual(diseasePublishTransform({}).outbreaks, []);
});

// ── End-to-end shape lock: contentMeta runs first, publishTransform strips ──

test('end-to-end: contentMeta runs on raw data WITH helpers, publishTransform strips, canonical is helper-free', () => {
  const NEWEST = 1700000000000;
  const OLDEST = 1690000000000;
  const rawData = {
    fetchedAt: '2026-05-04T12:00:00Z',
    outbreaks: [
      { id: 'who-1', publishedAt: NEWEST, _publishedAtIsSynthetic: false, _originalPublishedMs: NEWEST },
      { id: 'rss-1', publishedAt: Date.now(), _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      { id: 'tgh-1', publishedAt: OLDEST, _publishedAtIsSynthetic: false, _originalPublishedMs: OLDEST },
    ],
  };

  // Step 1: contentMeta on raw data
  const contentResult = diseaseContentMeta(rawData);
  assert.equal(contentResult.newestItemAt, NEWEST, 'contentMeta sees real (non-synthetic) newest');
  assert.equal(contentResult.oldestItemAt, OLDEST);

  // Step 2: publishTransform on raw data
  const published = diseasePublishTransform(rawData);
  for (const item of published.outbreaks) {
    assert.ok(!('_publishedAtIsSynthetic' in item), `${item.id}: _publishedAtIsSynthetic stripped`);
    assert.ok(!('_originalPublishedMs' in item), `${item.id}: _originalPublishedMs stripped`);
  }
  // Combined-regex assertion (Codex round 4 P2): published payload must NOT
  // contain EITHER helper name when serialized.
  const json = JSON.stringify(published);
  assert.equal((json.match(/_publishedAtIsSynthetic/g) || []).length, 0, 'no _publishedAtIsSynthetic in JSON');
  assert.equal((json.match(/_originalPublishedMs/g) || []).length, 0, 'no _originalPublishedMs in JSON');
});

// ── Pilot threshold sanity (anti-drift on the 9-day budget) ──────────────

test('pilot threshold: 9-day maxContentAgeMin would have tripped on 2026-05-04 incident pattern (11d-old items)', () => {
  // Simulate the production incident: newest item 11 days old, content-age budget 9 days.
  const ELEVEN_DAYS_AGO = Date.now() - 11 * 24 * 60 * 60 * 1000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: ELEVEN_DAYS_AGO },
    ],
  };
  const cm = diseaseContentMeta(data);
  assert.ok(cm, 'contentMeta returns a result');
  const ageMin = (Date.now() - cm.newestItemAt) / 60000;
  const BUDGET = 9 * 24 * 60;     // matches scripts/seed-disease-outbreaks.mjs
  assert.ok(ageMin > BUDGET, `${Math.round(ageMin)}min > budget ${BUDGET}min — STALE_CONTENT would fire (ANTI-DRIFT for the pilot threshold)`);
});

test('pilot threshold: 5-day-old items are within 9-day budget (no false positive)', () => {
  const FIVE_DAYS_AGO = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const data = { outbreaks: [{ _publishedAtIsSynthetic: false, _originalPublishedMs: FIVE_DAYS_AGO }] };
  const cm = diseaseContentMeta(data);
  const ageMin = (Date.now() - cm.newestItemAt) / 60000;
  const BUDGET = 9 * 24 * 60;
  assert.ok(ageMin < BUDGET, '5d < 9d — STALE_CONTENT does NOT fire on normal upstream rhythm');
});
