import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createRedisFetch} from './helpers/fake-upstash-redis.mts';
import rpc from '../api/infrastructure/v1/[rpc].ts';
import {issueSessionToken} from '../api/_session.js';
import {getTemporalBaseline} from '../server/worldmonitor/infrastructure/v1/get-temporal-baseline.ts';
const PATH='https://api.worldmonitor.app/api/infrastructure/v1/get-temporal-baseline';
async function setup(t: TestContext) {
  for (const [name, value] of Object.entries({
    WORLDMONITOR_VALID_KEYS: 'synthetic-enterprise', IRAN_EVENTS_ENABLED: 'false', WM_SESSION_SECRET: 'bootstrap-contract-synthetic-secret-32',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture',
    VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abcdef123456', BOOTSTRAP_R2_SHADOW_MEASURE: '0',
  })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const rateRedis = createRedisFetch({});
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
  t.after(() => assert.ok(warnings.every(line => !line.includes('[rate-limit]')), warnings.join('\n')));
  const values = new Map<string, unknown>();
  const reads: string[] = [];
  const origins = new Set<string>();
  t.after(() => assert.ok([...origins].every(origin => origin === 'https://redis.test')));
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    origins.add(origin);
    assert.equal(origin, 'https://redis.test');
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith('/get/')) {
      const key = decodeURIComponent(path.slice(5)); reads.push(key);
      return Response.json({ result: values.has(key) ? JSON.stringify(values.get(key)) : null });
    }
    const commands = JSON.parse(String(init?.body));
    if (!Array.isArray(commands[0]) || commands.some(([op]: string[]) => op !== 'GET')) {
      return rateRedis.fetchImpl(input, init);
    }
    return Response.json(commands.map(([op, key]: string[]) => {
      if (op !== 'GET') return { result: 1 };
      reads.push(key);
      return { result: values.has(key) ? JSON.stringify(values.get(key)) : null };
    }));
  });
  const token = (await issueSessionToken()).token;
  const request = (query: string, key = token) => rpc(new Request(PATH + query, { headers: { 'X-WorldMonitor-Key': key, Origin: 'https://worldmonitor.app' } }));
  return { values, reads, request, token };
}


test('global defaults remain readable for a supported browser session', async t => {
 const {reads,request,values}=await setup(t);
 const now=new Date(); const key=`baseline:v1:military_flights:global:${now.getUTCDay()}:${now.getUTCMonth()+1}`;
 values.set(key,{sampleCount:20,mean:2,m2:19});
 for(const suffix of ['', '&region=', '&region=global']) {
  const response=await request('?type=military_flights&count=2'+suffix);
  assert.equal(response.status,200); assert.equal((await response.json()).baseline.mean,2);
 }
 assert.deepEqual(reads,[key,key,key]);
});

test('supported session and enterprise callers cannot select arbitrary baseline regions', async t => {
 const {reads,request,token}=await setup(t);
 for(const region of ['arbitrary-fixture','fixture:with:colon','GLOBAL',' global','x'.repeat(1024)]) {
  for (const key of [token, 'synthetic-enterprise']) {
   const response=await request('?type=military_flights&count=2&region='+encodeURIComponent(region),key);
   assert.equal(response.status,400); assert.match(await response.text(),/region/);
  }
  await assert.rejects(getTemporalBaseline({} as never,{type:'military_flights',count:2,region}), (error: unknown)=> (error as {statusCode:number}).statusCode===400);
 }
 assert.equal(reads.length,0);
});

test('POST remains disabled before any baseline access', async t => {
 const {reads,token}=await setup(t);
 for(const region of ['global','arbitrary-fixture','fixture:with:colon']) {
  const response=await rpc(new Request(PATH.replace('get-temporal-baseline','record-baseline-snapshot'),{method:'POST',headers:{'X-WorldMonitor-Key':token,Origin:'https://worldmonitor.app','Content-Type':'application/json'},body:JSON.stringify({updates:[{type:'military_flights',count:2,region}]})}));
  assert.equal(response.status,region==='global'?403:400);
 }
 assert.equal(reads.length,0);
});

test('anonymous callers cannot reach the baseline reader', async t => {
 const {reads}=await setup(t);
 const response=await rpc(new Request(PATH+'?type=military_flights&count=2&region=global'));
 assert.ok([401,403].includes(response.status));
 assert.equal(reads.length,0);
});
