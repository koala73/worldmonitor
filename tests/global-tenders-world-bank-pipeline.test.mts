import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { main, fetchWorldBank } from '../scripts/seed-global-tenders.mjs';
import { listGlobalTenders } from '../server/worldmonitor/economic/v1/list-global-tenders';
import type { ListGlobalTendersRequest, ServerContext } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import { __testing__ as health } from '../api/health.js';
import { readSectionFreshness } from '../scripts/_bundle-runner.mjs';

const NOW = Date.parse('2026-09-11T14:00:00Z');
const KEY = 'economic:global-tenders:v1';
const SOURCE_KEY = `${KEY}:source:world-bank`;
const SOURCE_META = 'seed-meta:economic:global-tenders:world-bank';
const COMPLETE = 'seed-completion:economic:global-tenders';
const PAYLOAD = { procnotices: [{ id: 'OP1', notice_type: 'Invitation for Bids', bid_description: 'Network services',
  project_ctry_code: 'IN', submission_deadline_date: '2026-10-01T00:00:00Z' }] };
const REQUEST: ListGlobalTendersRequest = {
  country: '', countries: [], region: '', source: 'world-bank', status: '', deadlineFrom: '', deadlineTo: '',
  minValue: 0, maxValue: 0, currency: '', category: '', query: '', pageSize: 100, cursor: '', sort: 'closing_soon',
  buyer: '', publishedFrom: '', publishedTo: '', minAutomationScore: 0,
};

function fixture(t: TestContext) {
  const values = new Map<string, string>();
  const expires = new Map<string, number>();
  const logs: string[] = [];
  const state = { now: NOW, payload: structuredClone(PAYLOAD) as unknown, mode: 'ok', attempts: 0,
    siblingCalls: 0, siblingFailed: false, rejectWrite: '', rejectRead: false };
  const priorEnv = { ...process.env };
  const listeners = new Set(process.rawListeners('SIGTERM'));
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://redis.fixture', UPSTASH_REDIS_REST_TOKEN: 'fixture',
    WM_BUNDLE_COMPLETION_META_KEY: COMPLETE, WM_SEED_RETRY_DELAY_MS: '0' });
  delete process.env.LOCAL_API_MODE;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    for (const listener of process.rawListeners('SIGTERM')) if (!listeners.has(listener)) process.removeListener('SIGTERM', listener);
  });
  t.mock.method(Date, 'now', () => state.now);
  for (const level of ['log', 'warn', 'error'] as const) t.mock.method(console, level, (...args) => logs.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => { throw new Error(`exit ${code}`); });
  const get = (key: string) => {
    if ((expires.get(key) ?? Infinity) <= state.now) { values.delete(key); expires.delete(key); }
    return values.get(key) ?? null;
  };
  const read = (key: string) => JSON.parse(get(key) ?? 'null');
  const command = (cmd: Array<string | number>) => {
    const [op, rawKey, value] = cmd;
    const key = String(rawKey);
    if (op === 'SET') {
      values.set(key, String(value));
      const ex = cmd.indexOf('EX');
      if (ex >= 0) expires.set(key, state.now + Number(cmd[ex + 1]) * 1000);
      else expires.delete(key);
      return 'OK';
    }
    if (op === 'GET') return get(key);
    if (op === 'EXISTS') return get(key) == null ? 0 : 1;
    if (op === 'EXPIRE') { if (get(key) == null) return 0; expires.set(key, state.now + Number(value) * 1000); return 1; }
    if (op === 'DEL') return Number(values.delete(key));
    if (op === 'EVAL') return 1;
    throw new Error(`Unexpected Redis command ${op}`);
  };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'redis.fixture') {
      if (parsed.pathname.startsWith('/get/')) {
        const key = decodeURIComponent(parsed.pathname.slice(5));
        if (state.rejectRead && key === KEY) return new Response('{}', { status: 403 });
        return Response.json({ result: get(key) });
      }
      const body = JSON.parse(String(options.body));
      const cmds = Array.isArray(body[0]) ? body : [body];
      if (cmds.some((cmd: string[]) => cmd[0] === 'SET' && cmd[1] === state.rejectWrite)) return new Response('{}', { status: 403 });
      const results = cmds.map((cmd: Array<string | number>) => ({ result: command(cmd) }));
      return Response.json(Array.isArray(body[0]) ? results : results[0]);
    }
    assert.equal(parsed.hostname, 'search.worldbank.org', 'no unmocked provider requests');
    state.attempts++;
    if (state.mode === '500') return new Response('private upstream body', { status: 500 });
    if (state.mode === 'body-timeout-once' && state.attempts === 1) {
      return new Response(new ReadableStream({ start(controller) {
        controller.error(new DOMException('body timeout', 'TimeoutError'));
      } }));
    }
    return Response.json(state.payload);
  });
  const adapters = [['world-bank', fetchWorldBank], ['ted', async ({ now }: { now: number }) => {
    state.siblingCalls++;
    if (state.siblingFailed) throw new Error('sibling failed');
    return { records: [], status: { source: 'ted', state: 'ok', recordCount: 0,
      fetchedAt: new Date(now).toISOString(), lastSuccessfulAt: new Date(now).toISOString() } };
  }]];
  const run = async () => {
    try { await main({ adapters, now: state.now }); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'exit 0') throw error; }
  };
  const rpc = () => listGlobalTenders({ request: new Request('https://fixture/rpc') } as ServerContext, REQUEST);
  const sourceHealth = () => health.classifyKey('globalTendersWorldBank', SOURCE_KEY, { allowOnDemand: true }, {
    keyStrens: new Map([[SOURCE_KEY, get(SOURCE_KEY)?.length ?? 0]]), keyErrors: new Map(),
    keyMetaValues: new Map([[SOURCE_META, get(SOURCE_META)]]), keyMetaErrors: new Map(), now: state.now,
  });
  return { state, values, read, run, rpc, sourceHealth, logs };
}

test('actual producer/cache/RPC chain retries a failed body before publication', async t => {
  const f = fixture(t);
  f.state.mode = 'body-timeout-once';
  await f.run();
  assert.equal(f.state.attempts, 2);
  const response = await f.rpc();
  assert.equal(response.total, 1);
  assert.equal(response.sourceStatuses[0].state, 'ok');
  assert.equal(f.sourceHealth().status, 'OK');
  assert.equal(f.read(COMPLETE).fetchedAt, f.read(KEY)._seed.fetchedAt);
});

test('repeated HTTP 500 retains usable records and source clocks independently of the aggregate, then recovers', async t => {
  const f = fixture(t);
  await f.run();
  f.state.mode = '500';
  for (const minutes of [60, 120]) {
    f.state.now = NOW + minutes * 60_000;
    await f.run();
    const response = await f.rpc();
    assert.equal(response.total, 1);
    assert.equal(response.availability, 'partial');
    assert.equal(response.sourceStatuses[0].state, 'stale');
    assert.equal(Date.parse(response.sourceStatuses[0].lastSuccessfulAt), NOW);
    assert.equal(f.read(SOURCE_META).fetchedAt, NOW);
    assert.equal(f.read(SOURCE_META).lastAttemptAt, new Date(f.state.now).toISOString());
    assert.equal(f.sourceHealth().status, 'SEED_ERROR');
    assert.equal(f.read(KEY)._seed.fetchedAt, f.state.now);
    const freshness = await readSectionFreshness({ canonicalKey: KEY, completionMetaKey: COMPLETE }, async key => f.read(key));
    assert.equal(freshness.fetchedAt, f.state.now);
    assert.ok(f.state.now + 60 * 60_000 - freshness.fetchedAt >= 0.8 * 60 * 60_000, 'next hourly run remains due');
  }
  assert.equal(f.state.attempts, 7, 'one initial success and three attempts per failed run');
  assert.equal(f.read(SOURCE_META).consecutiveFailures, 2);
  assert.equal(f.logs.some(line => line.includes('private upstream body')), false);
  f.state.now += 30 * 60_000;
  f.state.mode = 'ok';
  await f.run();
  assert.equal((await f.rpc()).sourceStatuses[0].state, 'ok');
  assert.equal(f.read(SOURCE_META).fetchedAt, f.state.now);
  assert.equal(f.read(SOURCE_META).consecutiveFailures, 0);
  assert.equal(f.read(SOURCE_META).error, undefined);
});

for (const payload of [null, { procnotices: [{}] }, { total: 2, procnotices: PAYLOAD.procnotices }]) {
  test(`missing/malformed/partial provider data cannot clear a usable source: ${JSON.stringify(payload)}`, async t => {
    const f = fixture(t);
    await f.run();
    f.state.now += 60 * 60_000;
    f.state.payload = payload;
    await f.run();
    assert.equal((await f.rpc()).total, 1);
    assert.equal(f.sourceHealth().status, 'SEED_ERROR');
    assert.equal(f.read(SOURCE_META).fetchedAt, NOW);
  });
}

test('confirmed empty clears old data, and a subsequent failure stays distinct from empty success', async t => {
  const f = fixture(t);
  await f.run();
  f.state.now += 30 * 60_000;
  f.state.payload = { total: '0', procnotices: {} };
  await f.run();
  assert.equal((await f.rpc()).total, 0);
  assert.equal(f.read(SOURCE_META).sourceState, 'ok');
  const emptyAt = f.state.now;
  f.state.now += 30 * 60_000;
  f.state.mode = '500';
  await f.run();
  assert.equal(f.read(SOURCE_META).confirmedEmpty, true);
  assert.equal(f.read(SOURCE_META).fetchedAt, emptyAt);
  assert.equal(f.sourceHealth().status, 'SEED_ERROR');
});

for (const scenario of ['expired-deadline', 'expired-source', 'missing', 'unusable', 'unknown-clock']) {
  test(`failed source does not retain ${scenario} data or borrow the aggregate success clock`, async t => {
    const f = fixture(t);
    await f.run();
    const snapshot = f.read(KEY);
    if (scenario === 'expired-deadline') snapshot.data.tenders[0].deadline = new Date(NOW + 1).toISOString();
    if (scenario === 'unusable') snapshot.data.tenders[0].officialUrl = 'https://untrusted.test/';
    if (scenario === 'unknown-clock') snapshot.data.sourceStatuses[0] = { source: 'world-bank', state: 'error', fetchedAt: new Date(NOW).toISOString() };
    f.values.set(KEY, JSON.stringify(snapshot));
    if (scenario === 'missing') f.values.delete(KEY);
    f.state.mode = '500';
    // Keep refreshing the aggregate through healthy siblings, while World Bank ages out.
    for (const minutes of scenario === 'expired-source' ? [60, 120, 180] : [60]) {
      f.state.now = NOW + minutes * 60_000;
      await f.run();
    }
    assert.equal((await f.rpc()).total, 0);
    assert.equal(f.read(SOURCE_META).sourceState, 'error');
    assert.equal(f.read(SOURCE_META).fetchedAt, ['missing', 'unknown-clock'].includes(scenario) ? 0 : NOW);
    assert.notEqual(f.sourceHealth().status, 'OK');
  });
}

test('expired Redis canonical is unavailable at the actual reader', async t => {
  const f = fixture(t);
  await f.run();
  f.state.now += 181 * 60_000;
  assert.equal((await f.rpc()).availability, 'unavailable');
});

test('an initial all-source failure writes actionable source health without canonical or completion success', async t => {
  const f = fixture(t);
  f.state.mode = '500';
  f.state.siblingFailed = true;
  await f.run();
  assert.equal(f.read(KEY), null);
  assert.equal(f.read(COMPLETE), null);
  assert.equal(f.read(SOURCE_META).fetchedAt, 0);
  assert.equal(f.read(SOURCE_META).sourceState, 'error');
  assert.equal((await f.rpc()).availability, 'unavailable');
  assert.notEqual(f.sourceHealth().status, 'OK');
  assert.equal(f.logs.some(line => line.includes('seed_complete')), false);
});

test('failed source-status write prevents a new aggregate completion attestation', async t => {
  const f = fixture(t);
  await f.run();
  const completed = f.read(COMPLETE);
  f.state.now += 60 * 60_000;
  f.state.rejectWrite = SOURCE_META;
  await assert.rejects(f.run(), /403|exit 1/);
  assert.deepEqual(f.read(COMPLETE), completed);
  assert.equal(await readSectionFreshness({ canonicalKey: KEY, completionMetaKey: COMPLETE }, async key => f.read(key)), null);
});

test('a failed canonical read cannot publish an aggregate that silently drops retained World Bank data', async t => {
  const f = fixture(t);
  await f.run();
  const prior = f.read(KEY);
  const completed = f.read(COMPLETE);
  f.state.now += 60 * 60_000;
  f.state.mode = '500';
  f.state.rejectRead = true;
  await assert.rejects(f.run(), /exit 75/);
  assert.deepEqual(f.read(KEY), prior);
  assert.deepEqual(f.read(COMPLETE), completed);
  assert.equal(f.state.attempts, 1, 'failed cache dependency must stop before provider requests');
  assert.equal(f.state.siblingCalls, 1);
});
