// A failed FAA fetch used to re-extend aviation:delays:faa:v1 by its full 2h TTL
// on every tick, so during the 2026-11-25 outage the dashboard showed the
// 19:01Z ground delays as live for seven hours. It also pushed
// seed-meta:aviation:faa down to the same 2h TTL. Now last-good FAA delays are
// served only until the faaDelays health budget runs out, and seed-meta is left
// alone so health ages it into STALE. These tests run the real seeder against a
// fixture Redis and FAA. No PROXY_URL is set, so the proxy leg is not taken
// (tests/aviation-faa-fetch.test.mjs covers it).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const FAA_KEY = 'aviation:delays:faa:v1';
const FAA_META_KEY = 'seed-meta:aviation:faa';
const FAA_XML = '<AIRPORT_STATUS_INFORMATION><Update_Time>Wed Nov 25 19:01:09 2026 GMT</Update_Time>'
  + '<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>DCA</ARPT>'
  + '<Reason>thunderstorms</Reason><Avg>1 hour and 10 minutes</Avg><Max>2 hours</Max></Ground_Delay></Ground_Delay_List></Delay_type>'
  + '</AIRPORT_STATUS_INFORMATION>';

const preload = `
const faaKey = ${JSON.stringify(FAA_KEY)};
const metaKey = ${JSON.stringify(FAA_META_KEY)};
const fetchedAt = Date.now() - Number(process.env.TEST_META_AGE_MIN ?? 30) * 60_000;
const lastGood = { alerts: [{ id: 'faa-MIA', iata: 'MIA', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR' }] };
const values = new Map([
  [faaKey, JSON.stringify(lastGood)],
  [metaKey, JSON.stringify({ fetchedAt, recordCount: 1 })],
]);
if (process.env.TEST_META_MISSING) values.delete(metaKey);
const writes = [];
const expires = [];
let faaCalls = 0;
const command = ([verb, key, value, ...args]) => {
  if (verb === 'GET') return values.get(key) ?? null;
  if (verb === 'EXISTS') return values.has(key) ? 1 : 0;
  if (verb === 'SET') {
    if (args.includes('NX') && values.has(key)) return null;
    writes.push(key);
    values.set(key, value);
    return 'OK';
  }
  if (verb === 'EXPIRE') { expires.push([key, Number(value)]); return values.has(key) ? 1 : 0; }
  if (verb === 'EVAL') { values.delete(args[0]); return 1; }
  if (verb === 'LPUSH') return 1;
  if (verb === 'DEL') { values.delete(key); return 1; }
  throw new Error('Unexpected Redis command ' + verb);
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'seed-test.invalid') {
    if (url.pathname.startsWith('/get/')) {
      return Response.json({ result: values.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
    }
    const body = JSON.parse(options.body);
    // TEST_META_WRITE_FAIL: any request that writes FAA seed-meta answers HTTP 500.
    const touchesMeta = (Array.isArray(body[0]) ? body : [body]).some(([verb, key]) => verb === 'SET' && key === metaKey);
    if (process.env.TEST_META_WRITE_FAIL && touchesMeta) return new Response('upstream error', { status: 500 });
    // TEST_EXPIRE_FAIL: every EXPIRE on the FAA data key answers HTTP 500.
    const expiresFaa = (Array.isArray(body[0]) ? body : [body]).some(([verb, key]) => verb === 'EXPIRE' && key === faaKey);
    if (process.env.TEST_EXPIRE_FAIL && expiresFaa) return new Response('upstream error', { status: 500 });
    if (url.pathname === '/pipeline' || url.pathname === '/multi-exec') return Response.json(body.map(item => ({ result: command(item) })));
    return Response.json({ result: command(body) });
  }
  if (url.hostname === 'nasstatus.faa.gov') {
    faaCalls++;
    switch (process.env.TEST_FAA_MODE) {
      case 'fetchError': throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      case 'denied': return new Response('<HTML><TITLE>Access Denied</TITLE></HTML>', { status: 403, headers: { 'content-type': 'text/html' } });
      case 'html200': return new Response('<HTML><TITLE>Access Denied</TITLE></HTML>', { headers: { 'content-type': 'text/html' } });
      case 'ok': return new Response(${JSON.stringify(FAA_XML)}, { headers: { 'content-type': 'application/xml' } });
      default: throw new Error('unknown TEST_FAA_MODE');
    }
  }
  throw new Error('fixture source unavailable');
};
process.on('exit', () => {
  console.log('FIXTURE_STATE=' + JSON.stringify({
    faaCalls, writes, expires, initialFetchedAt: fetchedAt,
    faa: JSON.parse(values.get(faaKey) ?? 'null'),
    meta: JSON.parse(values.get(metaKey) ?? 'null'),
  }));
});
`;

function runAviation(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aviation-faa-'));
  const path = join(directory, 'preload.mjs');
  writeFileSync(path, preload);
  // An explicit empty env file keeps a developer's .env.local (and PROXY_URL) out of the child.
  const envFile = join(directory, 'empty.env');
  writeFileSync(envFile, '');
  try {
    const result = spawnSync(process.execPath, ['--import', path, 'seed-aviation.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        AVIATIONSTACK_API: '',
        AVIATIONSTACK_MONTHLY_BUDGET: '0',
        AVIATIONSTACK_MIN_REFRESH_MIN: '0',
        WM_SEED_RETRY_DELAY_MS: '0',
        WM_SEED_ENV_FILE: envFile,
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    // No AVIATIONSTACK_API key: the intl stage ends with its documented exit 75.
    assert.equal(result.status, 75, result.stdout + result.stderr);
    const stateLine = result.stdout.split('\n').find(line => line.startsWith('FIXTURE_STATE='));
    assert.ok(stateLine, result.stdout + result.stderr);
    return { ...result, state: JSON.parse(stateLine.slice('FIXTURE_STATE='.length)) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const mode of ['fetchError', 'denied', 'html200']) {
  test(`FAA ${mode} keeps last-good delays only for the rest of the health budget`, () => {
    const { state, stdout, stderr } = runAviation({ TEST_FAA_MODE: mode, TEST_META_AGE_MIN: '30' });
    const log = stdout + stderr;
    assert.equal(state.faaCalls, 1, log);
    assert.match(log, /\[FAA\] fetch\/write error: FAA direct: .*no proxy configured/);
    assert.equal(state.writes.includes(FAA_KEY), false, 'a failed fetch must not overwrite last-good delays');
    assert.equal(state.writes.includes(FAA_META_KEY), false, 'a failed fetch must not refresh seed-meta');
    assert.equal(state.meta.fetchedAt, state.initialFetchedAt);
    const faaTtl = state.expires.find(([key]) => key === FAA_KEY)?.[1];
    // 30 of 90 minutes used: the last-good snapshot may serve for about 60 more.
    assert.ok(faaTtl > 59 * 60 && faaTtl <= 60 * 60, `FAA key TTL ${faaTtl}s should be the remaining budget`);
    assert.equal(state.expires.some(([key]) => key === FAA_META_KEY), false, 'seed-meta TTL is left alone');
  });
}

// The key still carries up to two hours of its last write TTL, so leaving it to
// expire would let a 91-minute-old snapshot feed the freshly dated bootstrap
// aggregate for another half hour. Past the budget it is deleted.
test('FAA failure past the health budget deletes last-good delays', () => {
  const { state, stdout, stderr } = runAviation({ TEST_FAA_MODE: 'fetchError', TEST_META_AGE_MIN: '91' });
  const log = stdout + stderr;
  assert.match(log, /\[FAA\] .*past maxStaleMin 90; deleted them/);
  assert.equal(state.writes.includes(FAA_KEY), false);
  assert.equal(state.expires.some(([key]) => key === FAA_KEY), false, log);
  assert.equal(state.faa, null, 'stale FAA delays must not keep serving on their old TTL');
  assert.equal(state.meta.fetchedAt, state.initialFetchedAt, 'seed-meta stays so health reports STALE_SEED');
});

// extendExistingTtl answers false instead of throwing. Without the shorter
// expiry the key keeps its write TTL (up to 2h), past the 90-min budget.
test('FAA failure whose TTL cut fails deletes last-good delays', () => {
  const { state, stdout, stderr } = runAviation({ TEST_FAA_MODE: 'fetchError', TEST_META_AGE_MIN: '60', TEST_EXPIRE_FAIL: '1' });
  const log = stdout + stderr;
  assert.doesNotMatch(log, /kept last-good delays/);
  assert.match(log, /\[FAA\] could not shorten last-good delays .*; deleted them/);
  assert.equal(state.faa, null, log);
  assert.equal(state.meta.fetchedAt, state.initialFetchedAt);
});

test('FAA failure with unknown seed-meta age deletes last-good delays', () => {
  const { state, stdout, stderr } = runAviation({ TEST_FAA_MODE: 'fetchError', TEST_META_MISSING: '1' });
  assert.match(stdout + stderr, /\[FAA\] last-good delays \(unknown age\) are past maxStaleMin 90; deleted them/);
  assert.equal(state.faa, null);
});

test('FAA success publishes delays and fresh seed-meta', () => {
  const { state, stdout, stderr } = runAviation({ TEST_FAA_MODE: 'ok' });
  assert.equal(state.faaCalls, 1, stdout + stderr);
  assert.ok(state.writes.includes(FAA_KEY));
  assert.ok(state.writes.includes(FAA_META_KEY));
  assert.ok(state.meta.fetchedAt > state.initialFetchedAt);
  assert.match(stdout + stderr, /\[FAA\] 1 alerts via direct/);
});

// Data and seed-meta are published together. Writing the data first and then
// failing on seed-meta left the new delays in place, and the failure path then
// cut their TTL to the old snapshot's remaining budget (about a minute at 89).
test('a failed seed-meta write leaves neither half of the new FAA publish', () => {
  const { state, stdout, stderr } = runAviation({ TEST_FAA_MODE: 'ok', TEST_META_WRITE_FAIL: '1', TEST_META_AGE_MIN: '89' });
  const log = stdout + stderr;
  assert.equal(state.faaCalls, 1, log);
  assert.deepEqual(state.faa?.alerts?.map(a => a.iata), ['MIA'], 'the previous snapshot must stay intact');
  assert.equal(state.meta.fetchedAt, state.initialFetchedAt);
  assert.match(log, /\[FAA\] fetch\/write error: /);
});

test('the seeder FAA retention budget equals the health budget for faaDelays', async () => {
  const { __testing__: health } = await import('../api/health.js');
  const source = readFileSync(join(root, 'scripts', 'seed-aviation.mjs'), 'utf8');
  const budget = Number(source.match(/const FAA_MAX_STALE_MIN = (\d+);/)?.[1]);
  assert.equal(budget, health.SEED_META.faaDelays.maxStaleMin);
});
