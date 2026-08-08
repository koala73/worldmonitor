// Compact China-source health projection for the insights seeder. The digest
// intentionally records only exceptional feed states: an absent feedStatuses
// entry means that feed completed with at least one dated item. This projection
// keeps that source-level truth separate from the globally ranked top stories.

export const CHINA_NEWS_SOURCES = Object.freeze([
  { source: 'Xinhua', digestLanguage: 'en' },
  { source: 'MIIT (China)', digestLanguage: 'zh' },
  { source: 'MOFCOM (China)', digestLanguage: 'zh' },
]);

export const CHINA_NEWS_SOURCE_NAMES = Object.freeze(CHINA_NEWS_SOURCES.map(({ source }) => source));

const AVAILABLE_FEED_STATUSES = new Set([undefined, 'partial-undated']);

function toIsoTimestamp(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function buildChinaNewsCoverage(digestsByLanguage = {}) {
  const sources = CHINA_NEWS_SOURCES.map(({ source, digestLanguage }) => {
    const digest = digestsByLanguage[digestLanguage];
    if (!digest || typeof digest !== 'object') {
      return { source, status: 'unavailable', reason: 'digest_unavailable' };
    }
    const observedAt = toIsoTimestamp(digest.generatedAt);
    const feedStatuses = digest.feedStatuses && typeof digest.feedStatuses === 'object'
      ? digest.feedStatuses
      : {};
    const reason = feedStatuses[source];
    if (!observedAt) {
      return { source, status: 'unavailable', reason: 'digest_timestamp_missing' };
    }
    if (!AVAILABLE_FEED_STATUSES.has(reason)) {
      return { source, status: 'unavailable', reason: typeof reason === 'string' ? reason : 'unknown' };
    }
    return {
      source,
      status: 'available',
      observedAt,
      ...(reason ? { reason } : {}),
    };
  });

  return {
    countryCode: 'CN',
    sources,
  };
}
