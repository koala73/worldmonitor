import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchShfeNotices } from '../scripts/china-futures/shfe-notices.mjs';
import { validateSnapshot, CACHE_KEY } from '../scripts/china-futures/contract.mjs';
import { runChinaFuturesNoticesSeed } from '../scripts/seed-china-futures-notices.mjs';
import { readChinaFuturesRss } from '../api/_china-futures-news.js';

const now = Date.parse('2026-10-19T12:00:00+08:00');
const html = readFileSync(new URL('./fixtures/china-futures/shfe-notices.html', import.meta.url), 'utf8');
const fetchImpl = async () => new Response(html, { headers: { 'Content-Type': 'text/html' } });

test('publication contract rejects corrupt identities, dates, duplicates and empty payloads', async () => {
  const good = await fetchShfeNotices({ now, fetchImpl });
  assert.equal(validateSnapshot(good, now), true);
  for (const patch of [{ sourceUrl: 'https://evil.test/a' }, { documentId: 'other' }, { publicationDate: '2026-02-30' }, { publishedAt: new Date(now).toISOString() }, { revision: '' }, { datePrecision: 'second' }]) {
    assert.equal(validateSnapshot({ ...good, items: [{ ...good.items[0], ...patch }] }, now), false);
  }
  assert.equal(validateSnapshot({ ...good, items: [] }, now), false);
  assert.equal(validateSnapshot({ ...good, items: [...good.items, ...good.items] }, now), false);
  assert.equal(validateSnapshot({ ...good, fetchedAt: now + 1 }, now), false);
});

test('disabled seed performs no upstream or Redis operations; enabled seed uses the original contract', async () => {
  const fail = () => { throw new Error('unexpected operation'); };
  assert.deepEqual(await runChinaFuturesNoticesSeed({ enabled: false, fetchImpl: fail, runSeedFn: fail }), { disabled: true });
  await runChinaFuturesNoticesSeed({ enabled: true, fetchImpl, now, runSeedFn: async (domain, resource, key, fetcher, options) => {
    const payload = await fetcher();
    assert.equal(key, CACHE_KEY);
    assert.equal(`seed-meta:${domain}:${resource}`, 'seed-meta:news:china-futures:shfe:notices');
    assert.equal(options.validateFn(payload), true);
    assert.equal(options.declareRecords(payload), 1);
    assert.equal(options.zeroIsValid, false);
    assert.equal(options.schemaVersion, 1);
    assert.deepEqual(options.contentMeta(payload), { newestItemAt: Date.parse('2026-10-18T16:00:00Z'), oldestItemAt: Date.parse('2026-10-18T16:00:00Z') });
    assert.ok(options.ttlSeconds * 1000 > options.maxStaleMin * 60_000);
  } });
});

test('real publisher and reader retain the last good snapshot after a failed collection', async (t) => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const savedExit = process.exit;
  const store = new Map();
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.CHINA_FUTURES_NEWS_ENABLED = '1';
  const execute = ([op, key, value, ...args]) => {
    if (op === 'SET') { if ([value, ...args].includes('NX') && store.has(key)) return null; store.set(key, value); return 'OK'; }
    if (op === 'GET') return store.get(key) ?? null;
    if (op === 'DEL') return Number(store.delete(key));
    if (op === 'EXPIRE') return Number(store.has(key));
    if (op === 'EVAL') { const lockKey = args[0]; return Number(store.delete(lockKey)); }
    throw new Error(`Unsupported fixture Redis command: ${op}`);
  };
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://redis.example');
    if (target.pathname.startsWith('/get/')) return Response.json({ result: store.get(decodeURIComponent(target.pathname.slice(5))) ?? null });
    const command = JSON.parse(options.body);
    return Response.json(Array.isArray(command[0]) ? command.map((cmd) => ({ result: execute(cmd) })) : { result: execute(command) });
  };
  process.exit = (code) => { throw Object.assign(new Error('seed exit'), { seedExit: code }); };
  async function run(fetcher) {
    try { await runChinaFuturesNoticesSeed({ enabled: true, now: clock, fetchImpl: fetcher }); }
    catch (error) { if (error.seedExit !== undefined) return error.seedExit; throw error; }
  }
  try {
    assert.equal(await run(fetchImpl), 0);
    const published = store.get(CACHE_KEY);
    assert.ok(published);
    assert.match(await readChinaFuturesRss(clock), /中化兴中石油/);
    clock += 3600_000;
    await run(async () => new Response('verification', { headers: { 'Content-Type': 'text/html' } }));
    assert.equal(store.get(CACHE_KEY), published);
    assert.equal(JSON.parse(published).data.fetchedAt, now);
    assert.match(await readChinaFuturesRss(clock), /中化兴中石油/);
    clock += 24 * 3600_000;
    assert.equal(await readChinaFuturesRss(clock), null);
  } finally {
    globalThis.fetch = savedFetch;
    process.exit = savedExit;
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'CHINA_FUTURES_NEWS_ENABLED']) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});
