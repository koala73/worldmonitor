import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { listArxivPapers } from '../server/worldmonitor/research/v1/list-arxiv-papers';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { ValidationError } from '../src/generated/server/worldmonitor/research/v1/service_server';
import { fetchArxivPapers } from '../scripts/seed-research.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const cache = new Map<string, unknown>();
const keys: string[] = [];
const ctx = () => ({ request: new Request('https://worldmonitor.app/api/research/v1/list-arxiv-papers'), headers: {}, pathParams: {} });
const req = (category = '', pageSize = 50) => ({ category, pageSize, query: '', cursor: '' });
beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  cache.clear(); keys.length = 0;
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1]); keys.push(key);
    return Response.json({ result: cache.has(key) ? JSON.stringify(cache.get(key)) : null });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

test('empty category combines actual producer output across all tracked categories', async () => {
  const produced = await fetchArxivPapers({ retries: 0, sleepFn: async () => {}, fetchFn: async (url: string) => {
    const category = url.match(/cat:([^&]+)/)![1];
    return { ok: true, text: async () => `<feed><entry><id>http://arxiv.org/abs/${category}</id><title>${category}</title><published>2026-09-01T00:00:00Z</published><category term="${category}"/></entry></feed>` };
  } });
  for (const [key, value] of Object.entries(produced)) cache.set(key, value);
  const response = await listArxivPapers(ctx(), req());
  assert.deepEqual(response.papers.map((paper) => paper.id).sort(), ['cs.AI', 'cs.CL', 'cs.CR']);
  assert.equal(keys.length, 3);
});

test('deduplicates cross-listed papers and applies the page limit after newest-first merge', async () => {
  cache.set('research:arxiv:v1:cs.AI::50', { papers: [{ id: 'shared', publishedAt: 20 }, { id: 'old', publishedAt: 1 }] });
  cache.set('research:arxiv:v1:cs.CL::50', { papers: [{ id: 'shared', publishedAt: 20 }] });
  cache.set('research:arxiv:v1:cs.CR::50', { papers: [{ id: 'new', publishedAt: 30 }] });
  const response = await listArxivPapers(ctx(), req('', 2));
  assert.deepEqual(response.papers.map((paper) => paper.id), ['new', 'shared']);
  const selected = await listArxivPapers(ctx(), req('cs.CR'));
  assert.deepEqual(selected.papers.map((paper) => paper.id), ['new']);
});

test('rejects unsupported categories before any cache lookup', async () => {
  await assert.rejects(() => listArxivPapers(ctx(), req('../other:key')), ValidationError);
  assert.deepEqual(keys, []);
});

test('partial cache misses remain no-store while valid empty snapshots are distinct', async () => {
  cache.set('research:arxiv:v1:cs.AI::50', { papers: [{ id: 'available', publishedAt: 20 }] });
  const partialCtx = ctx();
  const partial = await listArxivPapers(partialCtx, req());
  assert.deepEqual(partial.papers.map((paper) => paper.id), ['available']);
  assert.equal(drainResponseHeaders(partialCtx.request)?.['X-No-Cache'], '1');
  cache.set('research:arxiv:v1:cs.AI::50', { papers: [] });
  const emptyCtx = ctx();
  assert.deepEqual(await listArxivPapers(emptyCtx, req('cs.AI')), { papers: [], pagination: undefined });
  assert.equal(drainResponseHeaders(emptyCtx.request), undefined);
});

test('malformed and failed sibling snapshots do not discard available papers', async () => {
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1]);
    if (key.includes('cs.CL')) throw new Error('fixture network failure');
    if (key.includes('cs.CR')) return Response.json({ result: '{' });
    return Response.json({ result: JSON.stringify({ papers: [null, { id: 'available', publishedAt: 20 }] }) });
  };
  const context = ctx();
  const response = await listArxivPapers(context, req());
  assert.deepEqual(response.papers.map((paper) => paper.id), ['available']);
  assert.equal(drainResponseHeaders(context.request)?.['X-No-Cache'], '1');
});
