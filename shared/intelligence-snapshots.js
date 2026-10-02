// Record-level validation for the seeded intelligence snapshots (satellites,
// travel advisories, GDELT topics), shared by the RPC handlers and the browser
// hydration/RPC boundaries.
//
// Each normalizer returns the snapshot with invalid records dropped, or null
// when the snapshot is unavailable: missing envelope, error/fallback marker,
// wrong container types, or records present but none of them valid. A single
// bad record never takes the whole feed down; a confirmed-empty snapshot is
// still valid.

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function snapshot(value) { return record(value) && !value.error && !value.fallback && value.dataAvailable !== false; }
function optionalStrings(value, fields) { return fields.every(field => value[field] == null || typeof value[field] === 'string'); }
function finiteOrAbsent(value) {
  return value == null || ((typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)));
}
/** Keep valid records; null when a non-empty list has no valid record at all. */
function keepValid(items, isValid) {
  const valid = items.filter(isValid);
  return items.length > 0 && valid.length === 0 ? null : valid;
}

export const INTEL_TOPIC_IDS = Object.freeze(['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime']);
// Travel-advisory registers cover far more than 100 countries. Confirmed-empty
// `{ advisories: [], byCountry: {} }` stays valid; a non-empty list with a thin
// index is unavailable so travel risk does not look available with blanks.
// scripts/seed-security-advisories.mjs keeps its own copy (it cannot import
// ../shared); tests/intelligence-snapshots.test.mts pins the two together.
export const MIN_ADVISORY_COUNTRY_COVERAGE = 100;

export function isSatelliteRecord(item) {
  if (!record(item)) return false;
  const id = item.id || item.noradId;
  return text(id) && text(item.name)
    && text(item.line1) && item.line1.length === 69 && item.line1.startsWith('1 ')
    && text(item.line2) && item.line2.length === 69 && item.line2.startsWith('2 ')
    && item.line1.slice(2, 7).trim() === id.trim()
    && item.line2.slice(2, 7).trim() === id.trim()
    && optionalStrings(item, ['country', 'type'])
    && ['alt', 'velocity', 'inclination'].every(field => finiteOrAbsent(item[field]));
}

export function normalizeSatelliteSnapshot(value) {
  if (!snapshot(value) || !Array.isArray(value.satellites)) return null;
  const satellites = keepValid(value.satellites, isSatelliteRecord);
  return satellites ? { satellites } : null;
}

export function isAdvisoryRecord(item) {
  return record(item)
    && text(item.title) && text(item.link) && text(item.source) && text(item.sourceCountry)
    && text(item.pubDate) && Number.isFinite(Date.parse(item.pubDate))
    && optionalStrings(item, ['level', 'country']);
}

export function normalizeAdvisorySnapshot(value) {
  if (!snapshot(value) || !Array.isArray(value.advisories) || !record(value.byCountry)) return null;
  const byCountry = Object.fromEntries(Object.entries(value.byCountry).filter(([, level]) => typeof level === 'string'));
  const coverage = Object.keys(byCountry).length;
  if (value.advisories.length === 0) return coverage === 0 ? { advisories: [], byCountry } : null;
  if (coverage < MIN_ADVISORY_COUNTRY_COVERAGE) return null;
  const advisories = keepValid(value.advisories, isAdvisoryRecord);
  return advisories ? { advisories, byCountry } : null;
}

export function isGdeltArticle(value) {
  return record(value) && text(value.title) && text(value.url)
    && ['source', 'date', 'image', 'language'].every(field => typeof value[field] === 'string')
    && typeof value.tone === 'number' && Number.isFinite(value.tone);
}

/** Search RPC response: invalid articles are dropped; null only when the envelope is unusable. */
export function normalizeGdeltSearchResponse(value) {
  if (!snapshot(value) || !Array.isArray(value.articles)) return null;
  const articles = keepValid(value.articles, isGdeltArticle);
  return articles ? { ...value, articles } : null;
}

/**
 * Seeded topic snapshot: every INTEL_TOPIC_IDS topic must be present (the
 * seeder always represents all six). Invalid articles are dropped per topic —
 * the seeder writes `title: String(raw.title || '')`, so one untitled article
 * must not blank the feed. Null when the envelope is malformed or every
 * article in the snapshot is invalid.
 */
export function normalizeGdeltTopicSnapshot(value) {
  if (!snapshot(value) || !Array.isArray(value.topics)
    || !value.topics.every(topic => record(topic) && text(topic.id) && Array.isArray(topic.articles))) return null;
  const ids = new Set(value.topics.map(topic => topic.id));
  if (!INTEL_TOPIC_IDS.every(id => ids.has(id))) return null;
  let total = 0;
  let kept = 0;
  const topics = value.topics.map(topic => {
    const articles = topic.articles.filter(isGdeltArticle);
    total += topic.articles.length;
    kept += articles.length;
    return { ...topic, articles };
  });
  if (total > 0 && kept === 0) return null;
  return { ...value, topics };
}
