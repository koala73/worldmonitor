import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import rpc from '../api/infrastructure/v1/[rpc].ts';
import intelligence from '../api/intelligence/v1/[rpc].ts';
import bootstrap from '../api/bootstrap.js';
import { issueSessionToken } from '../api/_session.js';
import { publishBootstrapTier } from '../scripts/publish-bootstrap-tiers.mjs';
import { listMarketImplications } from '../server/worldmonitor/intelligence/v1/list-market-implications.ts';
const PATH = 'https://api.worldmonitor.app/api/infrastructure/v1/get-bootstrap-data';
const SEED = 'intelligence:market-implications:v1';
const fixture = { cards: [{ ticker: 'SYNTH', title: 'premium-fixture-only', risk_caveat: 'test risk' }], generatedAt: '2026-09-11T00:00:00Z' };
async function setup(t: TestContext) {
  for (const [name, value] of Object.entries({
    IRAN_EVENTS_ENABLED: 'false', WM_SESSION_SECRET: 'bootstrap-contract-synthetic-secret-32',
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
  const request = (query: string) => rpc(new Request(PATH + query, { headers: { 'X-WorldMonitor-Key': token, Origin: 'https://worldmonitor.app' } }));
  return { values, reads, request, token };
}


test('public tiers and session bootstrap selectors never read premium market cards', async t => {
  const { values, reads, request, token } = await setup(t);
  values.set(SEED, fixture);
  values.set('news:insights:v1', { headlines: ['public fixture'] });
  for (const query of ['?tier=fast&public=1', '?tier=slow&public=1', '?keys=marketImplications&public=1', '?keys=marketImplications']) {
    const response = await bootstrap(new Request('https://api.worldmonitor.app/api/bootstrap' + query, { headers: query.includes('public=1') ? {} : { 'X-WorldMonitor-Key': token } }));
    if (query.includes('tier=')) assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /premium-fixture-only|marketImplications/);
  }
  for (const query of ['?tier=slow', '?keys=marketImplications']) {
    const response = await request(query);
    assert.ok(query.includes('tier=') ? response.status === 200 : [200, 400].includes(response.status));
    assert.doesNotMatch(await response.text(), /premium-fixture-only/);
  }
  assert.ok(!reads.includes(SEED));
  const insights = await request('?keys=insights');
  assert.deepEqual(JSON.parse((await insights.json()).data.insights), { headlines: ['public fixture'] });
});

test('canonical publisher excludes premium cards from both public tier envelopes', async t => {
  const { values, reads } = await setup(t);
  values.set(SEED, fixture);
  for (const tier of ['fast', 'slow']) {
    let written: unknown;
    await publishBootstrapTier(tier, { resolveStorage: () => ({}), putObject: async (_storage: unknown, _key: string, envelope: unknown) => { written = envelope; return { ok: true }; } });
    assert.ok(written);
    assert.doesNotMatch(JSON.stringify(written), /marketImplications|premium-fixture-only/);
  }
  assert.ok(!reads.includes(SEED));
});

test('premium RPC denies a public session while its handler preserves canonical seed mapping', async t => {
  const { values, token } = await setup(t);
  values.set(SEED, fixture);
  const response = await intelligence(new Request('https://api.worldmonitor.app/api/intelligence/v1/list-market-implications', { headers: { 'X-WorldMonitor-Key': token, Origin: 'https://worldmonitor.app' } }));
  assert.ok([401, 403].includes(response.status));
  assert.doesNotMatch(await response.text(), /premium-fixture-only/);
  const data = await listMarketImplications({} as never, { frameworkId: '' });
  assert.equal(data.cards[0]?.title, fixture.cards[0].title);
  assert.equal(data.cards[0]?.riskCaveat, 'test risk');
});

test('browser ignores old bootstrap cards and uses the premium RPC, then reuses its cache', async () => {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: ['src/services/market-implications.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'client-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/services\/(runtime|premium-fetch|bootstrap)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('/runtime')
        ? 'export const toApiUrl = path => path;'
        : args.path.endsWith('/bootstrap')
          ? 'export const getHydratedData = () => ({ cards: [{ title: "old public card" }] });'
          : 'export const premiumFetch = async url => { requests.push(url); return Response.json(fixture); };' }));
    } }],
  });
  const requests: string[] = [];
  const module = { exports: {} as { fetchMarketImplications: (framework?: string) => Promise<{ cards: Array<{ title: string; riskCaveat: string }> }> } };
  new Function('module', 'fixture', 'requests', 'Response', 'window', result.outputFiles[0]!.text)(module, fixture, requests, Response, { location: { origin: 'https://app.test' } });
  const first = await module.exports.fetchMarketImplications();
  assert.equal(first.cards[0]?.title, 'premium-fixture-only');
  assert.equal(first.cards[0]?.riskCaveat, 'test risk');
  assert.equal(requests.length, 1);
  assert.equal(await module.exports.fetchMarketImplications(), first);
  assert.equal(requests.length, 1);
  await module.exports.fetchMarketImplications('dalio-macro');
  assert.equal(new URL(requests[1]!).searchParams.get('frameworkId'), 'dalio-macro');
});
