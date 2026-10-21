// @vitest-environment node
import { beforeEach, afterEach, expect, test, vi } from 'vitest';

vi.mock('../_shared/user-api-key', async (original) => ({
  ...await original<typeof import('../_shared/user-api-key')>(),
  validateUserApiKey: async () => ({ userId: 'paid-account', keyId: 'synthetic-key', name: 'test' }),
}));
vi.mock('../_shared/entitlement-check', async (original) => ({
  ...await original<typeof import('../_shared/entitlement-check')>(),
  getEntitlements: async () => ({ planKey:'api_starter', validUntil:Date.now()+60000, features:{tier:2,apiAccess:true,apiRateLimit:60,apiDailyAllowance:1000} }),
}));
vi.mock('../_shared/api-key-rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/api-key-rate-limit')>(),
  checkBurst: async () => ({ok:true}),
  reserveDailyMeter: async () => ({count:1,overLimit:false,metered:true,retryAfterSec:60,rollback:async()=>{}}),
}));
import { createDomainGateway } from '../gateway';
import { __resetRateLimitForTest, ENDPOINT_RATE_POLICIES, FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED } from '../_shared/rate-limit';
import { listTelegramFeed } from '../worldmonitor/intelligence/v1/list-telegram-feed';
import { createIntelligenceServiceRoutes, type IntelligenceServiceHandler } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import restHandler from '../../api/telegram-feed.js';
import { issueSessionToken } from '../../api/_session.js';
import { __resetRateLimitForTest as resetRestLimiter } from '../../api/_rate-limit.js';

const PATH = '/api/intelligence/v1/list-telegram-feed';
const REST = '/api/telegram-feed';
const IP = '192.0.2.28';
const env = {...process.env};
const payload = { enabled:true, messages:[{id:'m1',channelId:'c1',channel:'test',text:'Synthetic full message body',timestamp:1700000000,mediaUrls:['https://media.invalid/photo.jpg'],sourceUrl:'https://t.me/test/1',topic:'test'}] };
let commands: unknown[][];
let relayCalls: string[];
let counters: Map<string,number>;
let redisStatus: number;
let gateway: ReturnType<typeof createDomainGateway>;
beforeEach(() => {
  __resetRateLimitForTest();
  resetRestLimiter();
  commands=[]; relayCalls=[]; counters=new Map(); redisStatus=200;
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  process.env.WM_SESSION_SECRET='synthetic-telegram-session-secret-28';
  process.env.WORLDMONITOR_VALID_KEYS='synthetic-enterprise-key';
  process.env.VERCEL_ENV='production';
  process.env.UPSTASH_REDIS_REST_URL='https://telegram-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN='synthetic';
  process.env.WS_RELAY_URL='https://telegram-relay.invalid';
  delete process.env.LOCAL_API_MODE;
  delete process.env.API_RATE_LIMIT_ENFORCE;
  vi.spyOn(globalThis,'fetch').mockImplementation(async (input, init) => {
    const url=new URL(String(input));
    if(url.hostname==='telegram-relay.invalid') {relayCalls.push(url.toString()); return Response.json(payload);}
    expect(url.hostname).toBe('telegram-redis.invalid');
    const body=JSON.parse(String(init?.body));
    expect(Array.isArray(body[0])).toBe(true);
    return Response.json(body.map((command: unknown[]) => {
      commands.push(command);
      expect(String(command[0]).toUpperCase()).toMatch(/^EVAL(SHA)?$/);
      const key=String(command[3]);
      const limit=Number(command[3+Number(command[2])]);
      const count=(counters.get(key)??0)+1;
      counters.set(key,count);
      return {result:[limit-count,limit]};
    }), {status:redisStatus});
  });
  const routes=createIntelligenceServiceRoutes({listTelegramFeed} as IntelligenceServiceHandler).filter(r=>r.path===PATH);
  gateway=createDomainGateway(routes);
});
afterEach(() => {
  vi.restoreAllMocks();
  for(const key of Object.keys(process.env)) if(!(key in env)) delete process.env[key];
  Object.assign(process.env,env);
});
async function request(path=PATH, headers:Record<string,string>={}, session=true) {
  const cookie=session ? {'Cookie':`wm-session=${(await issueSessionToken()).token}`} : {};
  const req=new Request(`https://worldmonitor.app${path}?limit=200&topic=test`,{headers:{'x-real-ip':IP,...cookie,...headers}});
  return path===REST ? restHandler(req) : gateway(req,{waitUntil:()=>{}});
}
function endpointKeys() {return commands.map(c=>String(c[3])).filter(k=>k.startsWith(`rl:ep:${PATH}:`));}

test('RPC has the narrow 60/minute endpoint policy',()=>{
  expect(ENDPOINT_RATE_POLICIES[PATH]).toEqual({limit:60,window:'60 s'});
  expect(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED).toHaveProperty(PATH);
});
test('rotating sessions share the RPC IP cap like the first-party route',async()=>{
  for(let i=0;i<60;i++) expect((await request()).status).toBe(200);
  const blocked=await request();
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('Retry-After')).toBeTruthy();
  expect(blocked.headers.get('RateLimit-Limit')).toBe('60');
  expect(blocked.headers.get('CDN-Cache-Control')).toBeNull();
  expect(await blocked.json()).toEqual({error:'Too many requests'});
  expect(relayCalls).toHaveLength(60);
  expect(new Set(endpointKeys()).size).toBe(1);
  expect(endpointKeys()[0]).toContain(`:ip:${IP}:`);
  for(let i=0;i<60;i++) expect((await request(REST)).status).toBe(200);
  expect((await request(REST)).status).toBe(429);
  expect(relayCalls).toHaveLength(120);
  expect(commands.some(c=>String(c[3]).startsWith(`rl:telegram-feed:feed:${IP}:`))).toBe(true);
});
for(const [name,headers,session] of [
  ['session',{},true],
  ['enterprise',{'X-WorldMonitor-Key':'synthetic-enterprise-key'},false],
  ['paid user key',{'X-Api-Key':'wm_'+'a'.repeat(40)},false],
] as const) {
  test(`preserves ${name} auth, full body and private cache contract`,async()=>{
    const response=await request(PATH,headers,session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({enabled:true,messages:[{id:'m1',channelId:'c1',channelName:'test',text:payload.messages[0]!.text,timestampMs:1700000000000,mediaUrls:payload.messages[0]!.mediaUrls,sourceUrl:'https://t.me/test/1',topic:'test'}],count:1,error:''});
    expect(new URL(relayCalls[0]!).searchParams.get('limit')).toBe('200');
    expect(response.headers.get('Cache-Control')).toMatch(/private/);
    expect(response.headers.get('CDN-Cache-Control')).toBeNull();
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBeNull();
    expect(endpointKeys()[0]).toContain(name==='paid user key'?':apikey-user:paid-account:':`:ip:${IP}:`);
  });
}
for(const headers of [{},{'X-Api-Key':'invalid-key'}]) {
  test(`rejects unsupported credentials before relay (${JSON.stringify(headers)})`,async()=>{
    expect((await request(PATH,headers,false)).status).toBe(401);
    expect(relayCalls).toHaveLength(0);
    expect(endpointKeys()).toHaveLength(0);
  });
}
for(const outage of ['missing','error']) {
  test(`fails closed on Redis ${outage} while REST retains its existing outage policy`,async()=>{
    if(outage==='missing') {delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;}
    else redisStatus=503;
    const response=await request();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(response.headers.get('X-RateLimit-Mode')).toBe('degraded');
    expect(response.headers.get('CDN-Cache-Control')).toBeNull();
    expect(relayCalls).toHaveLength(0);
    if(outage==='missing') expect((await request(REST)).status).toBe(200);
  },10000);
}

test('first-party feed already caps freely minted sessions at60/min/IP', async()=>{
  for(let i=0;i<60;i++) expect((await request(REST)).status).toBe(200);
  const blocked=await request(REST);
  expect(blocked.status).toBe(429);
  expect(relayCalls).toHaveLength(60);
});

test('verified keys share a paid account identity across keys and IPs',async()=>{
  await request(PATH,{'X-Api-Key':'wm_'+'a'.repeat(40)},false);
  await request(PATH,{'X-Api-Key':'wm_'+'b'.repeat(40),'x-real-ip':'192.0.2.29'},false);
  expect(endpointKeys()).toHaveLength(2);
  expect(new Set(endpointKeys()).size).toBe(1);
  expect(endpointKeys()[0]).toContain(':apikey-user:paid-account:');
});
test('a session key header preserves the same IP identity as session cookies',async()=>{
  const token=(await issueSessionToken()).token;
  expect((await request(PATH,{'X-WorldMonitor-Key':token},false)).status).toBe(200);
  expect(endpointKeys()[0]).toContain(`:ip:${IP}:`);
});
