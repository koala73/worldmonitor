import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { listNaturalEvents } from '../server/worldmonitor/natural/v1/list-natural-events.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { sanitizeBootstrapValue } from '../api/_bootstrap-public-payload.js';
import { projectNaturalEventsRetention } from '../api/_natural-events-dashboard.js';
import { __testing__ as health } from '../api/health.js';
import { fetchNaturalClimateDisasters } from '../scripts/seed-climate-disasters.mjs';

const START = Date.parse('2026-09-24T15:00:00Z');
const HOUR = 3_600_000;
const KEY = 'natural:events:v1';
const SNAPSHOT = 'natural:events:source-snapshots:v1';
const META = 'seed-meta:natural:events';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function seed(now: number, fixtures = {}, fail = false, empty = false) {
  const code = `
    import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
    Date.now = () => ${now};
    const fake = installRedis(${JSON.stringify(fixtures)}, { now: () => ${now} });
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://redis.example')) return fake.fetchImpl(url, init);
      const u = new URL(String(url));
      if (u.hostname.includes('eonet')) {
        if (${fail}) return new Response('', { status: 503 });
        return Response.json({ events: ${empty} ? [] : [
          { id: 'gdacs-FL-1', title: 'EONET volcano', categories: [{id:'volcanoes'}], geometry:[{type:'Point',coordinates:[10,20],date:new Date(${START}).toISOString()}], sources:[], closed:null },
          { id: 'eonet-duplicate', title: 'Duplicate flood', categories:[{id:'floods'}], geometry:[{type:'Point',coordinates:[30,40],date:new Date(${START}).toISOString()}], sources:[], closed:null }
        ] });
      }
      if (u.hostname==='www.gdacs.org' && u.searchParams.get('eventtype')==='FL') return Response.json({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[30,40]},properties:{eventtype:'FL',eventid:1,alertlevel:'Orange',name:'Flood',fromdate:new Date(${now}).toISOString(),iscurrent:'true'}}]});
      return Response.json({type:'FeatureCollection',features:[]});
    };
    const halt=Symbol('halt'); let exitCode;
    process.exit=code=>{exitCode=code;throw halt;};
    try { const {runNaturalEventsSeed}=await import('./scripts/seed-natural-events.mjs'); await runNaturalEventsSeed(); }
    catch(error) { if(error!==halt) throw error; }
    console.log('RESULT '+JSON.stringify({exitCode,values:Object.fromEntries([...fake.redis].map(([k,v])=>[k,JSON.parse(v)])),expires:Object.fromEntries(fake.expires)}));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child-v8', WM_SEED_RETRY_DELAY_MS: '0' },
  });
  assert.ifError(child.error);
  const result = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  assert.ok(result, child.stdout + child.stderr);
  const parsed = JSON.parse(result.slice(7));
  assert.equal(parsed.exitCode, 0, child.stdout + child.stderr);
  return parsed;
}

test('real seed writes eighteen-hour cache TTL while retained EONET expires absolutely across RPC, bootstrap and MCP', async t => {
  const first = seed(START);
  assert.equal(first.expires[KEY], 64800);
  assert.equal(first.expires[SNAPSHOT], 64800);
  assert.equal(first.values[SNAPSHOT].eonet.retainedUntil, START + 18 * HOUR);
  assert.deepEqual(first.values[KEY].data.eonetRetention.eventIndexes, [1]);
  const failed = seed(START + 10 * HOUR, first.values, true);
  const repeated = seed(START + 17 * HOUR, failed.values, true);
  assert.deepEqual(repeated.values[SNAPSHOT].eonet, first.values[SNAPSHOT].eonet);
  assert.equal(repeated.values[KEY].data.fetchedAt, START);
  assert.equal(repeated.values[META].sourceHealth.eonet.lastSuccessAt, START);
  assert.equal(repeated.values[META].errorCode, 'EONET_SOURCE_FAILED');
  const now = { value: START + 17 * HOUR };
  const store = createRedisFetch(repeated.values, { now: () => now.value,
    initialExpiresAt: { [KEY]: now.value + repeated.expires[KEY] * 1000, [SNAPSHOT]: now.value + repeated.expires[SNAPSHOT] * 1000 } });
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  t.mock.method(Date, 'now', () => now.value);
  t.mock.method(globalThis, 'fetch', store.fetchImpl);
  const retained = await listNaturalEvents({} as never, {});
  assert.equal(retained.events.length, 2);
  assert.equal(retained.fetchedAt, START);
  const classification = health.classifyKey('naturalEvents', KEY, { allowOnDemand: false }, {
    keyStrens: new Map([[KEY, 1000]]), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[META, JSON.stringify(repeated.values[META])]]), now: now.value,
  });
  assert.equal(classification.status, 'SEED_ERROR');
  assert.equal(classification.errorCode, 'EONET_SOURCE_FAILED');
  now.value = START + 18 * HOUR;
  const rpc = await listNaturalEvents({} as never, {});
  const raw = repeated.values[KEY].data;
  const bootstrap = sanitizeBootstrapValue('naturalEvents', raw);
  const tool = CACHE_TOOLS.find(tool => tool.name === 'get_natural_disasters')!;
  const mcp = { events: raw };
  tool._postFilter!(mcp, {});
  for (const response of [rpc, bootstrap, mcp.events]) {
    assert.equal(response.events.length, 1);
    assert.equal(response.events[0].sourceName, 'GDACS');
    assert.equal(response.fetchedAt, START);
    assert.equal('eonetRetention' in response, false);
  }
  assert.equal(raw.events.length, 2, 'projection must not mutate canonical cache');
  const climate = await fetchNaturalClimateDisasters();
  assert.equal(climate.length, 1);
  assert.equal(climate[0].source, 'GDACS');
  now.value = START + 35 * HOUR;
  const missing = await listNaturalEvents({} as never, {});
  assert.equal(missing.dataAvailable, false);
  assert.deepEqual(missing.events, []);
  const snapshotRead = await store.fetchImpl('https://redis.example/get/' + encodeURIComponent(SNAPSHOT));
  assert.equal((await snapshotRead.json()).result, null);

  const empty = seed(START + 11 * HOUR, failed.values, false, true);
  assert.deepEqual(empty.values[SNAPSHOT].eonet.records, []);
  assert.deepEqual(empty.values[META].failedSources, []);
  assert.equal(empty.values[META].sourceHealth.eonet.lastSuccessAt, START + 11 * HOUR);
  const expired = seed(START + 18 * HOUR, repeated.values, true);
  assert.equal(expired.values[SNAPSHOT].eonet, null);
  assert.equal(expired.values[KEY].data.events.length, 1);
});

test('legacy observations keep their nine-hour deadline and legacy payloads remain readable', () => {
  const first = seed(START);
  first.values[SNAPSHOT].eonet.retainedUntil = START + 9 * HOUR;
  const retained = seed(START + 8 * HOUR, first.values, true);
  assert.equal(retained.values[SNAPSHOT].eonet.retainedUntil, START + 9 * HOUR);
  const expired = seed(START + 9 * HOUR, retained.values, true);
  assert.equal(expired.values[SNAPSHOT].eonet, null);
  const legacy = { events: [{ id: 'legacy' }], fetchedAt: START };
  assert.equal(projectNaturalEventsRetention(legacy, START + 19 * HOUR), legacy);
  const onlyEonet = { ...legacy, eonetRetention: { retainedUntil: START + 18 * HOUR, eventIndexes: [0] } };
  assert.deepEqual(projectNaturalEventsRetention(onlyEonet, START + 18 * HOUR), {
    events: [], fetchedAt: START, dataAvailable: false,
  });
});
