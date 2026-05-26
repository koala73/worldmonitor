import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTravelSnapshot,
  feedsForCity,
  isTravelRelevant,
  parseRssXml,
} from '../scripts/export-travel-snapshot.mjs';

const RSS_FIXTURE = `
<rss><channel>
  <item>
    <title>Munich transit strike expected Friday</title>
    <link>https://example.test/munich-strike</link>
    <description>U-Bahn and tram services may face disruption near Marienplatz.</description>
    <pubDate>Tue, 26 May 2026 10:00:00 GMT</pubDate>
    <source>Example News</source>
  </item>
  <item>
    <title>Unrelated market update</title>
    <link>https://example.test/markets</link>
    <description>No relevant signal.</description>
  </item>
</channel></rss>`;

test('feedsForCity returns Munich travel feeds', () => {
  const feeds = feedsForCity('Munich');
  assert.ok(feeds.length >= 1);
  assert.match(feeds[0].url, /news\.google\.com\/rss\/search/);
  assert.match(feeds[0].query, /Munich/);
});

test('parseRssXml extracts source-backed items', () => {
  const items = parseRssXml(RSS_FIXTURE, { name: 'Fixture', url: 'https://example.test/rss' });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Munich transit strike expected Friday');
  assert.equal(items[0].link, 'https://example.test/munich-strike');
  assert.equal(items[0].source, 'Example News');
});

test('buildTravelSnapshot emits ontology-bridge compatible JSON', async () => {
  const snapshot = await buildTravelSnapshot({
    city: 'Munich',
    fetchedAt: '2026-05-26T12:00:00Z',
    maxItems: 5,
    fetchText: async () => RSS_FIXTURE,
  });

  assert.equal(snapshot.kind, 'worldmonitor_travel_snapshot');
  assert.equal(snapshot.city, 'Munich');
  assert.equal(snapshot.items.length, 3);
  assert.equal(snapshot.items[0].title, 'Munich transit strike expected Friday');
  assert.equal(snapshot.items[0].url, 'https://example.test/munich-strike');
  assert.equal(snapshot.items[0].fetchedAt, '2026-05-26T12:00:00Z');
  assert.ok(snapshot.items[0].places.includes('Munich'));
  assert.ok(snapshot.items[0].places.includes('Marienplatz'));
});

test('isTravelRelevant rejects city-missing noise', () => {
  assert.equal(
    isTravelRelevant({ title: 'Transit strike expected Friday', summary: '', places: [] }, 'Munich'),
    false,
  );
  assert.equal(
    isTravelRelevant({ title: 'Munich museum closure', summary: '', places: ['Munich'] }, 'Munich'),
    true,
  );
});
