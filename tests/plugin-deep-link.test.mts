import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostContextFromInitialize, mergeHostContext } from '../src/plugin-host-context.ts';
import { newsViewFromDeepLink } from '../src/plugin-deep-link.ts';

test('the host context carries the app-relative deep link from initialize and later updates', () => {
  const opened = hostContextFromInitialize({ hostContext: { 'openai/deepLink': { url: '/?country=IR' } } });
  assert.equal(opened.deepLink, '/?country=IR');
  const moved = mergeHostContext(opened, { hostContext: { 'openai/deepLink': { url: '/?country=TW' } } });
  assert.equal(moved.deepLink, '/?country=TW');
  // An update that does not mention the deep link keeps it.
  assert.equal(mergeHostContext(moved, { theme: 'dark' }).deepLink, '/?country=TW');
  assert.equal(hostContextFromInitialize({ hostContext: {} }).deepLink, undefined);
});

test('only an app-relative URL without a fragment is accepted as a deep link', () => {
  for (const url of ['https://evil.example/?country=IR', '//evil.example/', '?country=IR', '/?country=IR#x', 42, '/'.padEnd(2049, 'a')]) {
    assert.equal(hostContextFromInitialize({ hostContext: { 'openai/deepLink': { url } } }).deepLink, undefined, String(url).slice(0, 40));
  }
  assert.equal(hostContextFromInitialize({ hostContext: { 'openai/deepLink': '/?country=IR' } }).deepLink, undefined);
});

test('a news deep link uses the open_news_dashboard argument names', () => {
  const link = newsViewFromDeepLink('/?country=IR&category=conflict&time_range=24h&renderer=globe&query=strait%20of%20hormuz&source=Reuters');
  assert.deepEqual(link, {
    view: { country: 'IR', category: 'conflict', time_range: '24h', renderer: 'globe', query: 'strait of hormuz', source: 'Reuters' },
    ignored: [],
  });
});

test('map layers are comma-separated and the map center needs both coordinates', () => {
  assert.deepEqual(newsViewFromDeepLink('/?map_layers=natural,fires&map_latitude=26.5&map_longitude=56.3&map_zoom=5'), {
    view: { map_layers: ['natural', 'fires'], map_latitude: 26.5, map_longitude: 56.3, map_zoom: 5 },
    ignored: [],
  });
  assert.deepEqual(newsViewFromDeepLink('/?map_latitude=26.5&map_zoom=5'), { view: { map_zoom: 5 }, ignored: ['map_latitude'] });
});

test('invalid or unknown parameters are dropped one by one, not the whole link', () => {
  assert.deepEqual(newsViewFromDeepLink('/?country=Iran&time_range=year&map_zoom=99&map_layers=natural,nope&refresh=true&request_id=x&category=economy&utm_source=x'), {
    view: { category: 'economy' },
    ignored: ['country', 'time_range', 'map_zoom', 'map_layers', 'refresh', 'request_id', 'utm_source'],
  });
  // A lowercase country code is the same country.
  assert.deepEqual(newsViewFromDeepLink('/?country=ir').view, { country: 'IR' });
  assert.deepEqual(newsViewFromDeepLink('/?map_zoom=').view, {});
});

test('the root path is the only news deep link, so other paths stay free for later', () => {
  assert.deepEqual(newsViewFromDeepLink('/'), { view: {}, ignored: [] });
  assert.equal(newsViewFromDeepLink('/country/IR'), undefined);
});
