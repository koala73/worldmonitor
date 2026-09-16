function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function snapshot(value) { return record(value) && !value.error && !value.fallback && value.dataAvailable !== false; }
function optionalStrings(value, fields) { return fields.every(field => value[field] == null || typeof value[field] === 'string'); }

export const INTEL_TOPIC_IDS = Object.freeze(['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime']);
// Travel-advisory registers cover far more than 100 countries. Confirmed-empty
// `{ advisories: [], byCountry: {} }` stays valid; a non-empty list with a thin
// index is seed-unavailable so travel-risk does not look available with blanks.
export const MIN_ADVISORY_COUNTRY_COVERAGE = 100;

export function isSatelliteSnapshot(value) {
  return snapshot(value) && Array.isArray(value.satellites) && value.satellites.every(item =>
    record(item) && text(item.id || item.noradId) && text(item.name)
    && text(item.line1) && item.line1.length === 69 && item.line1.startsWith('1 ')
    && text(item.line2) && item.line2.length === 69 && item.line2.startsWith('2 ')
    && item.line1.slice(2, 7).trim() === (item.id || item.noradId).trim()
    && item.line2.slice(2, 7).trim() === (item.id || item.noradId).trim()
    && optionalStrings(item, ['country', 'type'])
    && ['alt', 'velocity', 'inclination'].every(field => item[field] == null
      || ((typeof item[field] === 'number' || typeof item[field] === 'string') && Number.isFinite(Number(item[field])))));
}

export function isAdvisorySnapshot(value) {
  if (!(snapshot(value) && Array.isArray(value.advisories)
    && record(value.byCountry) && Object.values(value.byCountry).every(v => typeof v === 'string')
    && value.advisories.every(item => record(item)
      && text(item.title) && text(item.link) && text(item.source) && text(item.sourceCountry)
      && text(item.pubDate) && Number.isFinite(Date.parse(item.pubDate))
      && optionalStrings(item, ['level', 'country'])))) return false;
  const coverage = Object.keys(value.byCountry).length;
  if (value.advisories.length === 0) return coverage === 0;
  return coverage >= MIN_ADVISORY_COUNTRY_COVERAGE;
}

export function isGdeltArticle(value) {
  return record(value) && text(value.title) && text(value.url)
    && ['source', 'date', 'image', 'language'].every(field => typeof value[field] === 'string')
    && typeof value.tone === 'number' && Number.isFinite(value.tone);
}

export function isGdeltSearchResponse(value) {
  return snapshot(value) && Array.isArray(value.articles) && value.articles.every(isGdeltArticle);
}

export function isGdeltTopicSnapshot(value) {
  if (!(snapshot(value) && Array.isArray(value.topics) && value.topics.length === INTEL_TOPIC_IDS.length
    && value.topics.every(topic => record(topic) && text(topic.id)
      && Array.isArray(topic.articles) && topic.articles.every(isGdeltArticle)))) return false;
  const ids = new Set(value.topics.map(topic => topic.id));
  return INTEL_TOPIC_IDS.every(id => ids.has(id));
}
