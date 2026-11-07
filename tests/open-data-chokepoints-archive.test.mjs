import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REDIS_KEYS,
  buildJsonSchema,
  buildSnapshot,
  createUpstashClient,
  importSnapshotDirToRedis,
  publishSnapshotToRedis,
  writeSnapshotFiles,
} from '../scripts/build-open-data-chokepoints.mjs';
import handler, { OPEN_DATA_CHOKEPOINT_KEYS } from '../api/open-data-chokepoints.js';

const UPSTASH_URL = 'https://upstash.test';
const body = JSON.parse(readFileSync(new URL('./fixtures/chokepoints-status-2026-11-02.json', import.meta.url), 'utf8')).body;
const snapshotFor = (snapshotDate, generatedAt = `${snapshotDate}T06:30:00.000Z`, input = body) =>
  buildSnapshot(input, { snapshotDate, generatedAt });

function fakeUpstash() {
  const store = new Map();
  const ttls = new Map();
  let failing = false;
  const exec = ([verb, key, value, ...flags]) => {
    if (verb === 'GET') return { result: store.has(key) ? store.get(key) : null };
    if (verb === 'SET') {
      if (flags.includes('NX') && store.has(key)) return { result: null };
      store.set(key, value);
      const ex = flags.indexOf('EX');
      if (ex >= 0) ttls.set(key, Number(flags[ex + 1]));
      else ttls.delete(key);
      return { result: 'OK' };
    }
    return { error: `ERR unknown command ${verb}` };
  };
  const fetchImpl = async (url, init = {}) => {
    if (failing) return { ok: false, status: 500, json: async () => ({ error: 'down' }) };
    const route = url.slice(UPSTASH_URL.length);
    let reply;
    if (route.startsWith('/get/')) reply = exec(['GET', decodeURIComponent(route.slice(5))]);
    else if (route === '/multi-exec') reply = JSON.parse(init.body).map(exec);
    else if (route === '') reply = exec(JSON.parse(init.body));
    else throw new Error(`unexpected Upstash route ${route}`);
    return { ok: true, status: 200, json: async () => reply };
  };
  return {
    store,
    ttls,
    fetchImpl,
    fail: (value) => {
      failing = value;
    },
    redis: createUpstashClient({ url: UPSTASH_URL, token: 'test-token', fetchImpl }),
  };
}

const snapshotOfStore = (store) =>
  Object.fromEntries([...store.entries()].filter(([key]) => key !== REDIS_KEYS.seedMeta && key !== REDIS_KEYS.activation));

describe('open data chokepoint Redis archive', () => {
  it('keeps the handler and the publisher on the same keys', () => {
    assert.equal(OPEN_DATA_CHOKEPOINT_KEYS.index, REDIS_KEYS.index);
    assert.equal(OPEN_DATA_CHOKEPOINT_KEYS.dayPrefix, REDIS_KEYS.dayPrefix);
  });

  it('publishes each day, moves latest forward only, and refuses to rewrite a past day', async () => {
    const upstash = fakeUpstash();
    await publishSnapshotToRedis(upstash.redis, snapshotFor('2026-11-06'));
    await publishSnapshotToRedis(upstash.redis, snapshotFor('2026-11-07'));
    assert.deepEqual(JSON.parse(upstash.store.get(REDIS_KEYS.index)), {
      schema_version: '1.0.0',
      dataset: 'worldmonitor-chokepoint-status',
      latest: '2026-11-07',
      dates: ['2026-11-06', '2026-11-07'],
    });

    const rerun = snapshotFor('2026-11-07', '2026-11-07T09:00:00.000Z');
    await publishSnapshotToRedis(upstash.redis, rerun);
    assert.equal(JSON.parse(upstash.store.get(`${REDIS_KEYS.dayPrefix}2026-11-07`)).json, `${JSON.stringify(rerun, null, 2)}\n`);

    const before = snapshotOfStore(upstash.store);
    await assert.rejects(
      () => publishSnapshotToRedis(upstash.redis, snapshotFor('2026-11-06', '2026-11-07T10:00:00.000Z')),
      /refusing to rewrite 2026-11-06\.json: a later snapshot \(2026-11-07\) already exists/,
    );
    assert.deepEqual(snapshotOfStore(upstash.store), before);

    await publishSnapshotToRedis(upstash.redis, snapshotFor('2026-11-05', '2026-11-07T11:00:00.000Z'));
    assert.deepEqual(JSON.parse(upstash.store.get(REDIS_KEYS.index)).dates, ['2026-11-05', '2026-11-06', '2026-11-07']);
    assert.equal(JSON.parse(upstash.store.get(REDIS_KEYS.index)).latest, '2026-11-07');
  });

  it('keeps the archive permanent and stamps seed-meta for health', async () => {
    const upstash = fakeUpstash();
    await publishSnapshotToRedis(upstash.redis, snapshotFor('2026-11-07'));
    assert.equal(upstash.ttls.has(REDIS_KEYS.index), false);
    assert.equal(upstash.ttls.has(`${REDIS_KEYS.dayPrefix}2026-11-07`), false);
    const meta = JSON.parse(upstash.store.get(REDIS_KEYS.seedMeta));
    assert.equal(meta.recordCount, 1);
    assert.equal(meta.latest, '2026-11-07');
    assert.equal(Number.isFinite(meta.fetchedAt), true);
    assert.equal(upstash.ttls.get(REDIS_KEYS.seedMeta), 7 * 86_400);
    assert.equal(upstash.store.get(REDIS_KEYS.activation), '1');
    assert.equal(upstash.ttls.has(REDIS_KEYS.activation), false);
  });

  it('refuses to publish over an index it cannot read', async () => {
    const upstash = fakeUpstash();
    upstash.store.set(REDIS_KEYS.index, JSON.stringify({ latest: '2026-11-07' }));
    await assert.rejects(() => publishSnapshotToRedis(upstash.redis, snapshotFor('2026-11-07')), /has no valid dates list/);
    assert.equal(upstash.store.has(`${REDIS_KEYS.dayPrefix}2026-11-07`), false);
  });

  it('imports a committed file archive byte for byte and keeps days Redis already holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-data-chokepoints-import-'));
    try {
      for (const date of ['2026-11-04', '2026-11-05', '2026-11-06']) await writeSnapshotFiles(dir, snapshotFor(date));
      const upstash = fakeUpstash();
      const held = snapshotFor('2026-11-06', '2026-11-06T07:00:00.000Z');
      await publishSnapshotToRedis(upstash.redis, held);

      const result = await importSnapshotDirToRedis(upstash.redis, dir);
      assert.deepEqual(result, { dates: ['2026-11-04', '2026-11-05', '2026-11-06'], imported: ['2026-11-04', '2026-11-05'] });
      for (const date of ['2026-11-04', '2026-11-05']) {
        const day = JSON.parse(upstash.store.get(`${REDIS_KEYS.dayPrefix}${date}`));
        assert.equal(day.json, await readFile(join(dir, `${date}.json`), 'utf8'));
        assert.equal(day.csv, await readFile(join(dir, `${date}.csv`), 'utf8'));
      }
      assert.equal(JSON.parse(upstash.store.get(`${REDIS_KEYS.dayPrefix}2026-11-06`)).json, `${JSON.stringify(held, null, 2)}\n`);
      assert.equal(upstash.store.get(REDIS_KEYS.index), await readFile(join(dir, 'index.json'), 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('open data chokepoint handler', () => {
  const upstash = fakeUpstash();
  const realFetch = globalThis.fetch;
  const env = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  const get = (file, method = 'GET') =>
    handler(new Request(`https://www.worldmonitor.app/api/open-data-chokepoints?file=${encodeURIComponent(file)}`, { method }));

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL = UPSTASH_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = upstash.fetchImpl;
  });
  after(() => {
    globalThis.fetch = realFetch;
    for (const [name, value] of [['UPSTASH_REDIS_REST_URL', env.url], ['UPSTASH_REDIS_REST_TOKEN', env.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('serves the same bytes the file writer produces for every published path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-data-chokepoints-serve-'));
    try {
      for (const date of ['2026-11-06', '2026-11-07']) {
        const snapshot = snapshotFor(date);
        await writeSnapshotFiles(dir, snapshot);
        await publishSnapshotToRedis(upstash.redis, snapshot);
      }
      const files = (await readdir(dir)).filter((name) => name !== 'schema.json').sort();
      assert.deepEqual(files, ['2026-11-06.csv', '2026-11-06.json', '2026-11-07.csv', '2026-11-07.json', 'index.json', 'latest.csv', 'latest.json']);
      for (const file of files) {
        const response = await get(file);
        assert.equal(response.status, 200, file);
        assert.equal(await response.text(), await readFile(join(dir, file), 'utf8'), file);
        assert.equal(response.headers.get('Content-Type'), file.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
        assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
        assert.equal(response.headers.get('CDN-Cache-Control'), 'public, s-maxage=3600, stale-while-revalidate=600');
      }
      const head = await get('latest.json', 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers 404 for a date the archive lacks or a path outside the dataset, with a short CDN TTL', async () => {
    for (const file of ['2026-10-01.json', 'latest.xml', '../index.json', 'schema.json', '']) {
      const response = await get(file);
      assert.equal(response.status, 404, file);
      assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60');
      assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'public, s-maxage=60', file);
    }
  });

  it('refuses dates that cannot be in the archive without reading Redis', async () => {
    const reads = [];
    globalThis.fetch = async (url, init) => {
      reads.push(url);
      return upstash.fetchImpl(url, init);
    };
    try {
      for (const file of ['2026-09-09.json', '2026-02-30.csv', '9999-12-31.json', '0000-00-00.csv']) {
        assert.equal((await get(file)).status, 404, file);
      }
      assert.deepEqual(reads, []);
      await get('2026-10-01.json');
      assert.equal(reads.length, 1);
    } finally {
      globalThis.fetch = upstash.fetchImpl;
    }
  });

  it('answers 503 without caching when Redis is unreachable', async () => {
    upstash.fail(true);
    try {
      const response = await get('latest.json');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
    } finally {
      upstash.fail(false);
    }
  });

  it('refuses methods other than GET and HEAD', async () => {
    assert.equal((await get('latest.json', 'POST')).status, 405);
  });
});

describe('open data chokepoint static files', () => {
  it('commits a schema.json that matches the generator', () => {
    const committed = readFileSync(new URL('../public/data/v1/chokepoints/schema.json', import.meta.url), 'utf8');
    assert.equal(committed, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`);
  });
});
