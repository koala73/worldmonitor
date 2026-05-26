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
// Test against the SAME functions the seeder imports from
// `scripts/_disease-outbreaks-helpers.mjs` — no local replicas, no drift.
// `diseaseContentMeta`'s `nowMs` parameter is injected with a fixed value so
// skew-limit tests are deterministic (no timing flakiness around the 1h
// boundary on loaded CI runners).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  whoNormalizeItem,
  rssNormalizeItem,
  tghNormalizeItem,
  diseaseContentMeta,
  diseasePublishTransform,
  DISEASE_MAX_CONTENT_AGE_MIN,
  detectAlertLevel,
  DISEASE_ALERT_KEYWORDS,
  DISEASE_WARNING_KEYWORDS,
  DISEASE_ALERT_RE,
  DISEASE_WARNING_RE,
  ALERT_LEVEL_METHODOLOGY_VERSION,
} from '../scripts/_disease-outbreaks-helpers.mjs';

// ── Pre-publish (in-memory) layer ────────────────────────────────────────

test('WHO record without PublicationDateAndTime → in-memory item is tagged synthetic', () => {
  const NOW = 1700000000000;
  const inMemory = whoNormalizeItem({ Title: 'Mpox - Country X', ItemDefaultUrl: '/mpox-x' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, true);
  assert.equal(inMemory._originalPublishedMs, null);
  assert.equal(inMemory.publishedMs, NOW, 'publishedMs falls back to now() so existing isFinite filters + UI consumer contract still hold');
});

test('WHO record with valid PublicationDateAndTime → in-memory item is non-synthetic', () => {
  const NOW = 1700000000000;
  const PUB_ISO = '2026-04-23T15:30:00Z';
  const PUB_MS = new Date(PUB_ISO).getTime();
  const inMemory = whoNormalizeItem({ Title: 'Mpox', ItemDefaultUrl: '/mpox', PublicationDateAndTime: PUB_ISO }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(inMemory._originalPublishedMs, PUB_MS);
  assert.equal(inMemory.publishedMs, PUB_MS);
});

test('RSS record without pubDate → in-memory item is tagged synthetic', () => {
  const NOW = 1700000000000;
  const inMemory = rssNormalizeItem({ title: 'Outbreak', link: 'http://x', desc: '', pubDate: '', sourceName: 'CDC' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, true);
  assert.equal(inMemory._originalPublishedMs, null);
  assert.equal(inMemory.publishedMs, NOW);
});

test('RSS record with valid pubDate → in-memory item is non-synthetic', () => {
  const NOW = 1700000000000;
  const PUB = 'Wed, 23 Apr 2026 15:30:00 GMT';
  const PUB_MS = new Date(PUB).getTime();
  const inMemory = rssNormalizeItem({ title: 'Outbreak', link: 'http://x', desc: '', pubDate: PUB, sourceName: 'CDC' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(inMemory._originalPublishedMs, PUB_MS);
  assert.equal(inMemory.publishedMs, PUB_MS);
});

test('TGH record always non-synthetic (line-198 filter rejects undated items earlier in the seeder)', () => {
  const inMemory = tghNormalizeItem({
    Alert_ID: '1', lat: 12.3, lng: 45.6, disease: 'Cholera', country: 'X',
    date: '4/23/2026', sourceUrl: 'http://x', summary: 's', cases: '5',
  });
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(typeof inMemory._originalPublishedMs, 'number');
  assert.ok(inMemory._originalPublishedMs > 0);
});

// ── contentMeta behavior ─────────────────────────────────────────────────
//
// All skew-limit tests inject `nowMs` so the assertion is deterministic
// regardless of loaded-CI scheduler timing — addresses the P2 reviewer
// finding about timing sensitivity around the 1h boundary.

const FIXED_NOW = 1700000000000;     // 2023-11-14T22:13:20.000Z — stable test "now"

test('contentMeta returns null when ALL items are synthetic', () => {
  const data = {
    outbreaks: [
      { id: 'a', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      { id: 'b', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
    ],
  };
  assert.equal(diseaseContentMeta(data, FIXED_NOW), null, 'all-synthetic → null → STALE_CONTENT');
});

test('contentMeta excludes synthetic items when mixed (does not let synthetic newest win)', () => {
  const PAST = 1690000000000;     // older than FIXED_NOW
  const data = {
    outbreaks: [
      // synthetic with VERY recent publishedMs (Date.now() fallback)
      { id: 'a', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      // real item, older but valid
      { id: 'b', publishedAt: PAST, _publishedAtIsSynthetic: false, _originalPublishedMs: PAST },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
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
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, NEWEST);
  assert.equal(result.oldestItemAt, OLDEST);
});

test('contentMeta excludes future-dated items beyond 1h clock-skew tolerance', () => {
  const REAL_RECENT = FIXED_NOW - 2 * 24 * 60 * 60 * 1000;
  const FUTURE = FIXED_NOW + 2 * 60 * 60 * 1000;    // 2h in the future — beyond 1h tolerance
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: FUTURE },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: REAL_RECENT },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, REAL_RECENT, 'future-dated item beyond 1h tolerance excluded — real most-recent wins');
});

test('contentMeta accepts items within 1h clock-skew tolerance', () => {
  // 5min ahead of FIXED_NOW — well inside the 1h tolerance window, well clear
  // of the skewLimit boundary. nowMs is injected so the comparison is
  // deterministic (independent of wall-clock timing).
  const NEAR_FUTURE = FIXED_NOW + 5 * 60 * 1000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: NEAR_FUTURE },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, NEAR_FUTURE, 'NEAR_FUTURE within 1h tolerance is accepted');
});

// ── publishTransform strip ───────────────────────────────────────────────

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
      { id: 'rss-1', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      { id: 'tgh-1', publishedAt: OLDEST, _publishedAtIsSynthetic: false, _originalPublishedMs: OLDEST },
    ],
  };

  // Step 1: contentMeta on raw data (use injected nowMs so the future-clock-skew filter is deterministic)
  const contentResult = diseaseContentMeta(rawData, FIXED_NOW);
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

test('DISEASE_MAX_CONTENT_AGE_MIN constant is 9 days', () => {
  assert.equal(DISEASE_MAX_CONTENT_AGE_MIN, 9 * 24 * 60, 'budget is 9 days — chosen so the 2026-05-04 11d incident trips STALE_CONTENT');
});

test('pilot threshold: 9-day maxContentAgeMin would have tripped on 2026-05-04 incident pattern (11d-old items)', () => {
  // Simulate the production incident: newest item 11 days old, content-age budget 9 days.
  const ELEVEN_DAYS_AGO = FIXED_NOW - 11 * 24 * 60 * 60 * 1000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: ELEVEN_DAYS_AGO },
    ],
  };
  const cm = diseaseContentMeta(data, FIXED_NOW);
  assert.ok(cm, 'contentMeta returns a result');
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(ageMin > DISEASE_MAX_CONTENT_AGE_MIN, `${Math.round(ageMin)}min > budget ${DISEASE_MAX_CONTENT_AGE_MIN}min — STALE_CONTENT would fire (ANTI-DRIFT for the pilot threshold)`);
});

test('pilot threshold: 5-day-old items are within 9-day budget (no false positive)', () => {
  const FIVE_DAYS_AGO = FIXED_NOW - 5 * 24 * 60 * 60 * 1000;
  const data = { outbreaks: [{ _publishedAtIsSynthetic: false, _originalPublishedMs: FIVE_DAYS_AGO }] };
  const cm = diseaseContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(ageMin < DISEASE_MAX_CONTENT_AGE_MIN, '5d < 9d — STALE_CONTENT does NOT fire on normal upstream rhythm');
});

// ── detectAlertLevel — keyword classifier (#3791) ─────────────────────────

test('detectAlertLevel: alert keywords as whole words map to alert', () => {
  for (const kw of DISEASE_ALERT_KEYWORDS) {
    assert.equal(
      detectAlertLevel(`Cholera ${kw} confirmed in country X`, ''),
      'alert',
      `keyword "${kw}" should trigger alert`,
    );
  }
});

test('detectAlertLevel: warning keywords as whole words map to warning', () => {
  for (const kw of DISEASE_WARNING_KEYWORDS) {
    assert.equal(
      detectAlertLevel(`Health ministry issues ${kw} after lab results`, ''),
      'warning',
      `keyword "${kw}" should trigger warning`,
    );
  }
});

test('detectAlertLevel: substring of an alert keyword does NOT promote (#3791 regression)', () => {
  // Prior substring matching let "epidemic" fire inside "antiepidemic" and
  // "outbreak" fire inside "outbreaking" (non-word). Word boundaries fix this.
  assert.equal(
    detectAlertLevel('New antiepidemic vaccination drive launched', ''),
    'watch',
    '"antiepidemic" must not match the bare "epidemic" keyword',
  );
  assert.equal(
    detectAlertLevel('Widespread vaccination program effective', ''),
    'watch',
    '"widespread" must not match the bare "spread" keyword',
  );
});

test('detectAlertLevel: case-insensitive matching', () => {
  assert.equal(detectAlertLevel('EBOLA OUTBREAK confirmed', ''), 'alert');
  assert.equal(detectAlertLevel('Cases Increasing in north', ''), 'warning');
});

test('detectAlertLevel: matches against title + desc concatenated', () => {
  assert.equal(detectAlertLevel('Cholera update', 'WHO declares emergency'), 'alert');
  assert.equal(detectAlertLevel('Status report', 'cases increasing across two regions'), 'warning');
});

test('detectAlertLevel: null/undefined inputs default to watch (no throw)', () => {
  assert.equal(detectAlertLevel(undefined, undefined), 'watch');
  assert.equal(detectAlertLevel(null, null), 'watch');
  assert.equal(detectAlertLevel('', ''), 'watch');
});

test('detectAlertLevel: alert wins over warning when both keyword classes match', () => {
  assert.equal(
    detectAlertLevel('Spread of outbreak confirmed', ''),
    'alert',
    'both "spread" (warning) and "outbreak" (alert) present — alert wins',
  );
});

test('DISEASE_ALERT_KEYWORDS and DISEASE_WARNING_KEYWORDS are frozen (#3791 change protocol)', () => {
  assert.ok(Object.isFrozen(DISEASE_ALERT_KEYWORDS), 'DISEASE_ALERT_KEYWORDS must be frozen to prevent runtime mutation');
  assert.ok(Object.isFrozen(DISEASE_WARNING_KEYWORDS), 'DISEASE_WARNING_KEYWORDS must be frozen to prevent runtime mutation');
});

test('ALERT_LEVEL_METHODOLOGY_VERSION is a non-empty version string', () => {
  assert.equal(typeof ALERT_LEVEL_METHODOLOGY_VERSION, 'string');
  assert.match(ALERT_LEVEL_METHODOLOGY_VERSION, /^v\d+/);
});

test('DISEASE_ALERT_RE and DISEASE_WARNING_RE are anchored on word boundaries (substring-bug guard)', () => {
  // Exported regexes give callers the right primitive directly — using them
  // instead of `text.includes(kw)` is the only safe way to check membership.
  assert.ok(DISEASE_ALERT_RE.test('Cholera outbreak confirmed'));
  assert.ok(!DISEASE_ALERT_RE.test('New antiepidemic vaccination drive'));
  assert.ok(DISEASE_WARNING_RE.test('Cases increasing in north'));
  assert.ok(!DISEASE_WARNING_RE.test('Widespread vaccination program'));
});

test('seed payload carries alertLevelMethodologyVersion post-publishTransform (version-field consumer)', () => {
  // Mirrors the shape produced by fetchDiseaseOutbreaks in
  // scripts/seed-disease-outbreaks.mjs. Asserts the version field survives
  // publishTransform so bumping ALERT_LEVEL_METHODOLOGY_VERSION observably
  // changes the wire payload (the methodology doc's change protocol step 1
  // now has a real consumer).
  const raw = {
    outbreaks: [
      { id: 'a', publishedAt: 1, _publishedAtIsSynthetic: false, _originalPublishedMs: 1 },
    ],
    fetchedAt: 1700000000000,
    alertLevelMethodologyVersion: ALERT_LEVEL_METHODOLOGY_VERSION,
  };
  const published = diseasePublishTransform(raw);
  assert.equal(
    published.alertLevelMethodologyVersion,
    ALERT_LEVEL_METHODOLOGY_VERSION,
    'wire payload must surface the methodology version so bumps propagate to clients',
  );
});
