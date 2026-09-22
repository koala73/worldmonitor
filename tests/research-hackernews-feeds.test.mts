import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fetchHackerNews } from '../scripts/seed-research.mjs';
import { listHackernewsItems } from '../server/worldmonitor/research/v1/list-hackernews-items';
import contracts from '../shared/openapi-filter-param-contracts.json' with { type: 'json' };

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const feeds = contracts.researchHackerNewsFeedTypes;
const idFor = (feed: string) => feeds.indexOf(feed) + 1;
const failedFeeds = new Set<string>();
const requested: string[] = [];
beforeEach(() => {
  failedFeeds.clear(); requested.length = 0;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  globalThis.fetch = async (url) => {
    const path = String(url);
    const feed = path.match(/\/([^/]+)stories.json$/)?.[1];
    if (feed) {
      requested.push(feed);
      if (failedFeeds.has(feed)) throw new Error('fixture list failure');
      return Response.json([idFor(feed)]);
    }
    const id = Number(path.match(/\/item\/(\d+).json$/)?.[1]);
    return Response.json({ id, type: id === idFor('job') ? 'job' : 'story', title: `Item ${id}`, time: 100, url: '', score: 7 });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

test('producer supplies every allowed feed including job items to the real reader', async () => {
  const produced = await fetchHackerNews();
  assert.deepEqual(requested.sort(), [...feeds].sort());
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1]);
    return Response.json({ result: produced[key] ? JSON.stringify(produced[key]) : null });
  };
  for (const feedType of feeds) {
    const context = { request: new Request('https://worldmonitor.app/research'), headers: {}, pathParams: {} };
    const response = await listHackernewsItems(context, { feedType, pageSize: 30, cursor: '' });
    assert.deepEqual(response.items.map((item) => item.id), [idFor(feedType)]);
    assert.equal(response.items[0].title, `Item ${idFor(feedType)}`);
  }
});

test('a failed added feed preserves successful sibling snapshots', async () => {
  failedFeeds.add('new');
  const produced = await fetchHackerNews();
  assert.equal(produced['research:hackernews:v1:new:30'], undefined);
  assert.deepEqual(produced['research:hackernews:v1:job:30'].items.map((item: { id: number }) => item.id), [idFor('job')]);
  assert.deepEqual(produced['research:hackernews:v1:top:30'].items.map((item: { id: number }) => item.id), [idFor('top')]);
});

test('each feed remains capped at 30 item reads and isolates item failures', async () => {
  let itemReads = 0;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('stories.json')) return Response.json(Array.from({ length: 45 }, (_, index) => index + 1));
    itemReads++; active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve(); active--;
    const id = Number(String(url).match(/item\/(\d+)/)![1]);
    if (id === 1) throw new Error('fixture item failure');
    return Response.json({ id, type: 'story', title: `Item ${id}` });
  };
  const produced = await fetchHackerNews();
  assert.equal(itemReads, 180);
  assert.equal(maxActive, 10);
  for (const feed of feeds) {
    assert.equal(produced[`research:hackernews:v1:${feed}:30`].items.length, 29);
    assert.equal(produced[`research:hackernews:v1:${feed}:30`].items[0].id, 2);
  }
});
