import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTEL_TOPIC_IDS,
  MIN_ADVISORY_COUNTRY_COVERAGE,
  isAdvisorySnapshot,
  isGdeltTopicSnapshot,
} from '../shared/intelligence-snapshots.js';
import { INTEL_TOPIC_IDS as SEED_INTEL_TOPIC_IDS } from '../scripts/seed-gdelt-intel.mjs';
import { MIN_ADVISORY_COUNTRY_COVERAGE as SEED_MIN_ADVISORY_COUNTRY_COVERAGE } from '../scripts/seed-security-advisories.mjs';

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

function coveredByCountry(count = MIN_ADVISORY_COUNTRY_COVERAGE): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `C${String(i).padStart(3, '0')}`,
    i === 0 ? 'caution' : 'normal',
  ]));
}

function topicSnapshot(ids: readonly string[], articlesById: Record<string, typeof article[]> = {}) {
  return { topics: ids.map(id => ({ id, articles: articlesById[id] ?? [] })) };
}

test('seed INTEL_TOPIC_IDS stay the six shared snapshot ids', () => {
  assert.deepEqual([...SEED_INTEL_TOPIC_IDS], [...INTEL_TOPIC_IDS]);
  assert.equal(INTEL_TOPIC_IDS.length, 6);
});

test('advisory seeder floor stays aligned with the shared snapshot constant', () => {
  assert.equal(SEED_MIN_ADVISORY_COUNTRY_COVERAGE, MIN_ADVISORY_COUNTRY_COVERAGE);
});

test('isAdvisorySnapshot keeps confirmed-empty 200 and rejects thin country indexes', () => {
  assert.equal(isAdvisorySnapshot({ advisories: [], byCountry: {} }), true);
  assert.equal(isAdvisorySnapshot({ advisories: [advisory], byCountry: {} }), false);
  assert.equal(isAdvisorySnapshot({ advisories: [advisory], byCountry: { UA: 'caution' } }), false);
  assert.equal(isAdvisorySnapshot({
    advisories: [advisory],
    byCountry: coveredByCountry(MIN_ADVISORY_COUNTRY_COVERAGE - 1),
  }), false);
  assert.equal(isAdvisorySnapshot({
    advisories: [advisory],
    byCountry: coveredByCountry(),
  }), true);
  assert.equal(isAdvisorySnapshot({ advisories: [], byCountry: { UA: 'caution' } }), false);
});

test('isGdeltTopicSnapshot requires every INTEL_TOPICS id', () => {
  assert.equal(isGdeltTopicSnapshot({ topics: [{ id: 'military', articles: [] }] }), false);
  assert.equal(isGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS.slice(0, 5))), false);
  assert.equal(isGdeltTopicSnapshot(topicSnapshot(['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'other'])), false);
  assert.equal(isGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS)), true);
  assert.equal(isGdeltTopicSnapshot(topicSnapshot(INTEL_TOPIC_IDS, { military: [article] })), true);
});
