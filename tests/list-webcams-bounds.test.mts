import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { listWebcams } from '../server/worldmonitor/webcam/v1/list-webcams';
import { createWebcamServiceRoutes } from '../src/generated/server/worldmonitor/webcam/v1/service_server';

const originalEnv = { ...process.env };
let commands: unknown[][];
let responseKeys: string[];
let cache: Map<string, unknown>;
let cameras: Array<{ webcamId: string; title: string; lat: number; lng: number; category: string; country: string }>;
const empty = { webcams: [], clusters: [], totalInView: 0 };
const route = createWebcamServiceRoutes({ listWebcams, getWebcamImage: async () => { throw new Error('not used'); } })[0]!;
beforeEach(() => {
  commands = [];
  responseKeys = [];
  cache = new Map();
  cameras = [];
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  process.env.UPSTASH_REDIS_REST_URL = 'https://webcam-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'webcam-redis.invalid');
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      commands.push(['GET', key]);
      if (key === 'webcam:cameras:active') return Response.json({ result: JSON.stringify('seed-v1') });
      responseKeys.push(key);
      return Response.json({ result: cache.has(key) ? JSON.stringify(cache.get(key)) : null });
    }
    const body = JSON.parse(String(init?.body));
    if (url.pathname === '/pipeline') {
      commands.push(...body);
      if (body[0][0] === 'HMGET') {
        assert.equal(body[0][1], 'webcam:cameras:meta:seed-v1');
        return Response.json([{ result: body[0].slice(2).map((id: string) => JSON.stringify(cameras.find(c => c.webcamId === id))) }]);
      }
      assert.equal(body[0][0], 'GEOSEARCH');
      return Response.json([{ result: cameras.map(c => c.webcamId) }]);
    }
    commands.push(body);
    assert.equal(body[0], 'SET');
    cache.set(body[1], JSON.parse(body[2]));
    return Response.json({ result: 'OK' });
  });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
async function request(overrides: Record<string, string | number> = {}) {
  const params = new URLSearchParams(Object.entries({ zoom: 5, bound_w: 10.2, bound_s: 20.2, bound_e: 15.2, bound_n: 25.2, ...overrides }).map(([k,v]) => [k,String(v)]));
  return route.handler(new Request(`https://worldmonitor.invalid/api/webcam/v1/list-webcams?${params}`));
}
const searches = () => commands.filter(c => c[0] === 'GEOSEARCH');
for (const field of ['zoom', 'bound_w', 'bound_s', 'bound_e', 'bound_n']) {
  for (const value of ['NaN', 'Infinity', '-Infinity', 'not-a-number']) {
    it(`rejects ${field}=${value} before Redis`, async () => {
      const response = await request({ [field]: value });
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json()).violations.map((v: {field: string}) => v.field), [{ zoom:'zoom',bound_w:'boundW',bound_s:'boundS',bound_e:'boundE',bound_n:'boundN' }[field]]);
      assert.deepEqual(commands, []);
    });
  }
}
it('preserves ordinary cache quantization, GEOSEARCH, TTL and response', async () => {
  assert.deepEqual(await (await request()).json(), empty);
  assert.deepEqual(responseKeys, ['webcam:resp:seed-v1:5:10:20:16:26']);
  assert.deepEqual(searches()[0], ['GEOSEARCH','webcam:cameras:geo:seed-v1','FROMLONLAT','13','23','BYBOX',String(6*111.32*Math.cos(23*Math.PI/180)),String(6*111.32),'km','ASC','COUNT','2000']);
  assert.equal(commands.find(c => c[0] === 'SET')?.[4], '3600');
  await request({ bound_w: 10.8, bound_s: 20.8, bound_e: 15.8, bound_n: 25.8 });
  assert.equal(searches().length, 1);
});
it('normalizes fractional and excessive zoom instead of fragmenting cache identities', async () => {
  for (const zoom of [5, 4.01, 4.99]) await request({ zoom });
  assert.deepEqual(new Set(responseKeys), new Set(['webcam:resp:seed-v1:5:10:20:16:26']));
  assert.equal(searches().length, 1);
  for (const zoom of [22, 1e200, Number.MAX_VALUE]) await request({ zoom });
  assert.equal(new Set(responseKeys).size, 2);
  for (const zoom of [0, -1e200, -Number.MAX_VALUE]) await request({ zoom });
  assert.equal(new Set(responseKeys).size, 3);
});
it('constrains extreme bounds to the existing full-globe query', async () => {
  await request({ bound_w:-180,bound_s:-90,bound_e:180,bound_n:90 });
  await request({ bound_w:-Number.MAX_VALUE,bound_s:-Number.MAX_VALUE,bound_e:Number.MAX_VALUE,bound_n:Number.MAX_VALUE });
  assert.equal(new Set(responseKeys).size, 1);
  assert.equal(searches().length, 1);
  assert.deepEqual(searches()[0]?.slice(3,9), ['0','0','BYBOX',String(360*111.32),String(180*111.32),'km']);
});
it('preserves antimeridian split queries and seeded geo keys', async () => {
  await request({ bound_w:170.2,bound_e:-170.2,bound_s:-5.2,bound_n:5.2 });
  assert.deepEqual(responseKeys, ['webcam:resp:seed-v1:5:170:-6:-170:6']);
  assert.deepEqual(searches().map(c => c.slice(1,9)), [
    ['webcam:cameras:geo:seed-v1','FROMLONLAT','175','0','BYBOX',String(10*111.32),String(12*111.32),'km'],
    ['webcam:cameras:geo:seed-v1','FROMLONLAT','-175','0','BYBOX',String(10*111.32),String(12*111.32),'km'],
  ]);
});

for (const [zoom, singles, clusterSize] of [[2,0,5],[2.99,0,5],[3,1,4],[4,1,4],[4.01,2,3],[6,2,3],[6.01,3,2],[8,3,2],[8.01,5,0],[10,5,0],[22,5,0]]) {
  it(`preserves seeded-camera clustering at zoom ${zoom}`, async () => {
    cameras = [0.1,0.2,0.6,2.1,5.1].map((lat,i) => ({ webcamId: `camera-${i}`, title: `Camera ${i}`, lat, lng:0.1, category:'city', country:'XX' }));
    const response = await request({ zoom: zoom! });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.totalInView, 5);
    assert.equal(result.webcams.length, singles);
    assert.deepEqual(result.clusters.map((c: {count:number}) => c.count), clusterSize ? [clusterSize] : []);
    if (!clusterSize) assert.deepEqual(result.webcams, cameras);
  });
}
it('bounds every extreme-coordinate combination before forming geometry or cache identity', async () => {
  for (let mask=0; mask<16; mask++) {
    const bounds = Object.fromEntries(['bound_w','bound_s','bound_e','bound_n'].map((field,i) => [field, (mask & (1 << i) ? 1 : -1) * Number.MAX_VALUE]));
    assert.equal((await request(bounds)).status, 200);
  }
  for (const command of searches()) {
    const [lon,lat,width,height] = [3,4,6,7].map(i => Number(command[i]));
    assert.ok([lon,lat,width,height].every(Number.isFinite));
    assert.ok(Math.abs(lon!) <=180 && Math.abs(lat!) <=90);
    assert.ok(width! >=0 && width! <=360*111.32);
    assert.ok(height! >=0 && height! <=180*111.32);
  }
  for (const key of responseKeys) assert.doesNotMatch(key, /Infinity|NaN|e\+/);
});
