import assert from 'node:assert/strict';
import { it } from 'node:test';
import { extractFeeds, extractServerFeeds, fetchFeed } from '../scripts/validate-rss-feeds.mjs';

const adapter = 'https://api.worldmonitor.app/api/miit-news';

it('validates the configured server MIIT adapter and preserves the local browser feed', async (t) => {
  const client = extractFeeds().find((feed) => feed.name === 'MIIT (China)');
  const server = extractServerFeeds().find((feed) => feed.name === 'MIIT (China)');
  assert.equal(client.url, '/api/miit-news');
  assert.equal(client.isLocal, true);
  assert.equal(server.url, adapter);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response('<rss/>');
  });
  assert.equal(await fetchFeed(server.url, { ci: true }), '<rss/>');
  assert.deepEqual(calls, [adapter]);
});

it('does not authorize other API routes, parameterized targets, or untrusted origins', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('<rss/>'));
  for (const url of [
    'https://api.worldmonitor.app/api/rss-proxy?url=http://127.0.0.1',
    'https://api.worldmonitor.app/api/miit-news/other',
    `${adapter}?url=http://127.0.0.1`,
    `${adapter}#fragment`,
    'https://user:password@api.worldmonitor.app/api/miit-news',
    'https://api.worldmonitor.app:8443/api/miit-news',
    'https://api.worldmonitor.app.evil.example/api/miit-news',
    'http://api.worldmonitor.app/api/miit-news',
    'https://127.0.0.1/api/miit-news',
  ]) {
    await assert.rejects(fetchFeed(url, { ci: true }), /allowlist|Non-https/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

it('rechecks the URL boundary on redirects from the MIIT adapter', async (t) => {
  for (const location of [
    '/api/rss-proxy?url=http://127.0.0.1',
    'https://169.254.169.254/latest/meta-data/',
    `${adapter}?url=https://example.com`,
  ]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
      status: 302, headers: { location },
    }));
    await assert.rejects(fetchFeed(adapter, { ci: true }), /allowlist/);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

it('preserves ordinary allowlisted feeds and safe per-hop redirects', async (t) => {
  const feed = 'https://feeds.bbci.co.uk/news/world/rss.xml';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: adapter } })
      : new Response('<rss/>');
  });
  assert.equal(await fetchFeed(feed, { ci: true }), '<rss/>');
  assert.deepEqual(calls, [feed, adapter]);
});
