import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIMATE_NEWS_MAX_ITEM_AGE_MS,
  resolveReliefWebUrl,
  selectClimateNewsItems,
} from '../scripts/_climate-news-helpers.mjs';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const DAY = 86_400_000;
const item = (title, ageDays, url = `https://example.org/${encodeURIComponent(title)}`) => ({
  title,
  url,
  publishedAt: NOW - ageDays * DAY,
  summary: '',
});

test('ReliefWeb absolute url_alias values keep a single host', () => {
  assert.equal(
    resolveReliefWebUrl('https://reliefweb.int/report/central-african-republic/bulletin'),
    'https://reliefweb.int/report/central-african-republic/bulletin',
  );
  assert.equal(resolveReliefWebUrl('/report/world/heat'), 'https://reliefweb.int/report/world/heat');
  assert.equal(resolveReliefWebUrl(''), '');
});

test('articles older than the item age cap are dropped before the cap fills', () => {
  assert.equal(CLIMATE_NEWS_MAX_ITEM_AGE_MS, 30 * DAY);
  const selected = selectClimateNewsItems([
    { feed: {}, items: [item('The looming threat for Maine potato industry', 1658), item('Hurricane season wrap-up', 1)] },
  ], NOW);
  assert.deepEqual(selected.map((i) => i.title), ['Hurricane season wrap-up']);
});

test('Mars imagery from Earth-science feeds is excluded', () => {
  const selected = selectClimateNewsItems([
    {
      feed: {},
      items: [
        item('A Collage Showing 49 Drill Holes Made by NASA’s Curiosity Mars Rover', 2),
        item('Curiosity Rover Spots Drifting Twilight Clouds', 3),
        item('El Niño Rains Paint the Atacama', 4),
      ],
    },
  ], NOW);
  assert.deepEqual(selected.map((i) => i.title), ['El Niño Rains Paint the Atacama']);
});

test('topic-gated feeds keep only climate or environment reports', () => {
  const selected = selectClimateNewsItems([
    {
      feed: { requireTopicMatch: true },
      items: [
        item('Local Leadership in the Age of AI: How Artificial Intelligence Is Reshaping Humanitarian Action', 1),
        item('Mécanisme de réponse humanitaire : République centrafricaine, Bulletin bimestriel', 2),
        item('Bangladesh: Monsoon Floods Flash Update No. 3', 3),
        item('Sécheresse au Sahel : note de situation', 4),
      ],
    },
    { feed: {}, items: [item('Lightning could strike more than twice as often', 5)] },
  ], NOW);
  assert.deepEqual(selected.map((i) => i.title), [
    'Bangladesh: Monsoon Floods Flash Update No. 3',
    'Sécheresse au Sahel : note de situation',
    'Lightning could strike more than twice as often',
  ]);
});

test('selection is newest first, URL-deduplicated and capped', () => {
  const shared = 'https://example.org/same';
  const selected = selectClimateNewsItems([
    { feed: {}, items: [item('older copy', 3, shared), item('a', 2), item('b', 1)] },
    { feed: {}, items: [item('newer copy', 0.5, shared)] },
  ], NOW, 2);
  assert.deepEqual(selected.map((i) => i.title), ['newer copy', 'b']);
});
