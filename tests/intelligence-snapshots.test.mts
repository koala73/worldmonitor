import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTEL_TOPIC_IDS,
  MIN_ADVISORY_COUNTRY_COVERAGE,
  normalizeAdvisorySnapshot,
  normalizeGdeltSearchResponse,
  normalizeGdeltTopicSnapshot,
  normalizeSatelliteSnapshot,
} from '../shared/intelligence-snapshots.js';
import { INTEL_TOPIC_IDS as SEED_INTEL_TOPIC_IDS } from '../scripts/seed-gdelt-intel.mjs';
import { MIN_ADVISORY_COUNTRY_COVERAGE as SEED_MIN_ADVISORY_COUNTRY_COVERAGE } from '../scripts/seed-security-advisories.mjs';

const satellite = { id: '25544', name: 'ISS', country: 'US', type: 'station', line1: '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992', line2: '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442' };
const advisory = {
  title: 'Travel update',
  link: 'https://example.com/advice',
  pubDate: '2026-09-15T00:00:00Z',
  source: 'FCDO',
  sourceCountry: 'UK',
  level: 'caution',
  country: 'UA',
};
const article = {
  title: 'Military exercise',
  url: 'https://example.com/news',
  source: 'example.com',
  date: '20260915T000000Z',
  image: '',
  language: 'English',
  tone: 0,
};
// scripts/seed-gdelt-intel.mjs normalizeArticle writes `title: String(raw.title || '')`.
const untitled = { ...article, title: '', url: 'https://example.com/untitled' };

function coveredByCountry(count = MIN_ADVISORY_COUNTRY_COVERAGE): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `C${String(i).padStart(3, '0')}`,
    i === 0 ? 'caution' : 'normal',
  ]));
}

function topicSnapshot(ids: readonly string[], articlesById: Record<string, unknown[]> = {}) {
  return { topics: ids.map(id => ({ id, articles: articlesById[id] ?? [] })) };
}

test('seed INTEL_TOPIC_IDS stay the six shared snapshot ids', () => {
  assert.deepEqual([...SEED_INTEL_TOPIC_IDS], [...INTEL_TOPIC_IDS]);
  assert.equal(INTEL_TOPIC_IDS.length, 6);
});

test('advisory seeder floor stays aligned with the shared snapshot constant', () => {
  assert.equal(SEED_MIN_ADVISORY_COUNTRY_COVERAGE, MIN_ADVISORY_COUNTRY_COVERAGE);
});

test('advisory snapshot keeps confirmed-empty and rejects thin country indexes', () => {
  assert.deepEqual(normalizeAdvisorySnapshot({ advisories: [], byCountry: {} }), { advisories: [], byCountry: {} });
  assert.equal(normalizeAdvisorySnapshot({ advisories: [advisory], byCountry: {} }), null);
  assert.equal(normalizeAdvisorySnapshot({ advisories: [advisory], byCountry: { UA: 'caution' } }), null);
  assert.equal(normalizeAdvisorySnapshot({
    advisories: [advisory],
    byCountry: coveredByCountry(MIN_ADVISORY_COUNTRY_COVERAGE - 1),
  }), null);
  assert.equal(normalizeAdvisorySnapshot({ advisories: [advisory], byCountry: coveredByCountry() })?.advisories.length, 1);
  assert.equal(normalizeAdvisorySnapshot({ advisories: [], byCountry: { UA: 'caution' } }), null);
  assert.equal(normalizeAdvisorySnapshot({ advisories: [advisory], byCountry: coveredByCountry(), fallback: true }), null);
});

test('advisory snapshot drops invalid records and keeps the valid ones', () => {
  const normalized = normalizeAdvisorySnapshot({
    advisories: [advisory, { ...advisory, pubDate: 'bad' }, null, { ...advisory, title: '' }],
    byCountry: coveredByCountry(),
  });
  assert.deepEqual(normalized?.advisories, [advisory]);
  assert.equal(normalizeAdvisorySnapshot({ advisories: [{ ...advisory, pubDate: 'bad' }], byCountry: coveredByCountry() }), null);
});

test('satellite snapshot drops invalid TLE records and keeps the valid ones', () => {
  assert.deepEqual(normalizeSatelliteSnapshot({ satellites: [] }), { satellites: [] });
  assert.deepEqual(
    normalizeSatelliteSnapshot({ satellites: [satellite, { ...satellite, line1: 'broken' }, null] })?.satellites,
    [satellite],
  );
  assert.equal(normalizeSatelliteSnapshot({ satellites: [{ ...satellite, line2: 'broken' }] }), null);
  assert.equal(normalizeSatelliteSnapshot({ satellites: {} }), null);
  assert.equal(normalizeSatelliteSnapshot(null), null);
});

test('GDELT topic snapshot requires every INTEL_TOPICS id', () => {
  assert.equal(normalizeGdeltTopicSnapshot({ topics: [{ id: 'military', articles: [] }] }), null);
  assert.equal(normalizeGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS.slice(0, 5))), null);
  assert.equal(normalizeGdeltTopicSnapshot(topicSnapshot(['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'other'])), null);
  assert.deepEqual(normalizeGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS)), topicSnapshot(INTEL_TOPIC_IDS));
  assert.deepEqual(
    normalizeGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS, { military: [article] })),
    topicSnapshot(INTEL_TOPIC_IDS, { military: [article] }),
  );
});

test('one untitled GDELT article is dropped without marking the seed unavailable', () => {
  const normalized = normalizeGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS, {
    military: [article, untitled],
    cyber: [{ ...article, url: 'https://example.com/cyber' }],
  }));
  assert.ok(normalized, 'a single untitled article must not blank the whole seed');
  assert.deepEqual(normalized.topics.find(topic => topic.id === 'military')?.articles, [article]);
  assert.equal(normalized.topics.find(topic => topic.id === 'cyber')?.articles.length, 1);
});

test('a GDELT snapshot whose every article is malformed is unavailable', () => {
  assert.equal(normalizeGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS, { military: [untitled], cyber: [{ title: 3 }] })), null);
  assert.equal(normalizeGdeltTopicSnapshot({ topics: [null] }), null);
  assert.equal(normalizeGdeltTopicSnapshot({ topics: {} }), null);
});

test('GDELT search response drops invalid articles; a malformed envelope is unavailable', () => {
  assert.deepEqual(
    normalizeGdeltSearchResponse({ articles: [article, untitled], query: 'military', error: '' })?.articles,
    [article],
  );
  assert.deepEqual(normalizeGdeltSearchResponse({ articles: [], query: 'military', error: '' })?.articles, []);
  assert.equal(normalizeGdeltSearchResponse({ articles: [], query: 'military', error: 'seed-unavailable' }), null);
  assert.equal(normalizeGdeltSearchResponse({ articles: [untitled], query: 'military', error: '' }), null);
});
