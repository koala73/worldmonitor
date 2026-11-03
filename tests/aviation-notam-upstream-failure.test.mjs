// The NOTAM side-car must fail loudly. An ICAO outage (retired route, HTML
// challenge, bad JSON, timeout, quota) once published `{closedIcaos: []}` plus a
// fresh seed-meta:aviation:notam, so /api/health kept reporting OK while every
// NOTAM-only airport (Jeddah, Medina, Dammam) showed "Coverage unavailable".
// These tests run the real seeder against a fixture Redis + ICAO.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const NOTAM_KEY = 'aviation:notam:closures:v2';
const NOTAM_META_KEY = 'seed-meta:aviation:notam';

const preload = `
const notamKey = ${JSON.stringify(NOTAM_KEY)};
const metaKey = ${JSON.stringify(NOTAM_META_KEY)};
const fetchedAt = Date.now() - Number(process.env.TEST_META_AGE_MIN ?? 30) * 60_000;
const lastGood = { closedIcaos: ['OEDF'], restrictedIcaos: [], reasons: { OEDF: 'AD CLSD' } };
const values = new Map([
  [notamKey, JSON.stringify(lastGood)],
  [metaKey, JSON.stringify({ fetchedAt, recordCount: 1 })],
]);
// seed-notam-nms.mjs publishes this key in runSeed contract mode, so it is
// stored as a {_seed, data} envelope.
if (process.env.TEST_NMS_MODE) {
  const ageMin = process.env.TEST_NMS_MODE === 'stale' ? 31 : 4;
  const generatedAt = Date.now() - ageMin * 60_000;
  values.set('aviation:notam:nms:closures:v1', JSON.stringify({
    _seed: { fetchedAt: generatedAt, recordCount: 3, sourceVersion: 'faa-nms-api-v1', schemaVersion: 1, state: 'OK' },
    data: {
      closedIcaos: ['OEJN', 'KZZZ'].concat(process.env.TEST_NMS_MODE === 'dashboard' ? ['HSSK'] : []),
      restrictedIcaos: ['OEMA', 'OEDF'],
      reasons: { OEJN: 'AD CLSD (NMS)', KZZZ: 'AD AP CLSD', OEMA: 'RESTRICTED (NMS)', OEDF: 'AD AP CLSD TO NON SKED GA', HSSK: 'AD CLSD' },
      coveredIcaos: ['EGKK', 'KZZZ', 'OEJN', 'OIIE'],
      generatedAt,
    },
  }));
}
if (process.env.TEST_NMS_ACTIVATED) values.set('seed-activated:aviation:notam-nms:v1', '1');
const writes = [];
const expires = [];
const pushes = [];
let icaoCalls = 0;
const command = ([verb, key, value, ...args]) => {
  if (verb === 'GET') return values.get(key) ?? null;
  if (verb === 'EXISTS') return values.has(key) ? 1 : 0;
  if (verb === 'SET') {
    if (args.includes('NX') && values.has(key)) return null;
    writes.push(key);
    values.set(key, value);
    return 'OK';
  }
  if (verb === 'EXPIRE') {
    expires.push([key, value]);
    return values.has(key) ? 1 : 0;
  }
  if (verb === 'EVAL') { values.delete(args[0]); return 1; }
  if (verb === 'LPUSH') { pushes.push(JSON.parse(value)); return 1; }
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
    // TEST_REDIS_FAIL_KEYS: every command on these keys answers HTTP 500.
    const failKeys = (process.env.TEST_REDIS_FAIL_KEYS || '').split(',').filter(Boolean);
    if (!Array.isArray(body[0]) && failKeys.includes(body[1])) return new Response('upstream error', { status: 500 });
    if (url.pathname === '/pipeline') return Response.json(body.map(item => ({ result: command(item) })));
    return Response.json({ result: command(body) });
  }
  if (url.hostname === 'dataservices.icao.int') {
    icaoCalls++;
    switch (process.env.TEST_ICAO_MODE) {
      case 'retired': return Response.json('Invalid API Call', { status: 404 });
      case 'html': return new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
      case 'badJson': return new Response('{not json', { headers: { 'content-type': 'application/json' } });
      case 'notArray': return Response.json({ error: 'Invalid API Call' });
      case 'fetchError': throw new TypeError('fetch failed', { cause: new Error('fixture connection reset') });
      case 'timeout': throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      case 'quota': return new Response('Reach call limit', { status: 403, headers: { 'content-type': 'text/plain' } });
      case 'ok': return Response.json([
        { itema: 'OEJN', code23: 'FA', code45: 'LC', iteme: 'AD CLSD DUE TO MIL ACT' },
        { itema: 'OEMA', code23: 'RA', code45: 'RT', iteme: 'TEMPORARY RESTRICTED AREA' },
      ]);
      case 'okEmpty': return Response.json([]);
      default: throw new Error('unknown TEST_ICAO_MODE');
    }
  }
  throw new Error('fixture source unavailable');
};
process.on('exit', () => {
  console.log('FIXTURE_STATE=' + JSON.stringify({
    icaoCalls, writes, expires, pushes, initialFetchedAt: fetchedAt,
    notam: JSON.parse(values.get(notamKey) ?? 'null'),
    meta: JSON.parse(values.get(metaKey) ?? 'null'),
  }));
});
`;

function runAviation(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aviation-notam-'));
  const path = join(directory, 'preload.mjs');
  writeFileSync(path, preload);
  // An explicit empty env file keeps a developer's .env.local out of the child.
  const envFile = join(directory, 'empty.env');
  writeFileSync(envFile, '');
  try {
    const result = spawnSync(process.execPath, ['--import', path, 'seed-aviation.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        ICAO_API_KEY: 'fixture-icao-key',
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
    // The fixture has no AVIATIONSTACK_API key, so the intl stage ends with its
    // documented exit 75 (tests/aviation-graceful-fetch.test.mjs). Anything else
    // means the run crashed somewhere, NOTAM side-car included.
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /FATAL/);
    const stateLine = result.stdout.split('\n').find(line => line.startsWith('FIXTURE_STATE='));
    assert.ok(stateLine, result.stdout + result.stderr);
    return { ...result, state: JSON.parse(stateLine.slice('FIXTURE_STATE='.length)) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const mode of ['retired', 'html', 'badJson', 'notArray', 'fetchError', 'timeout', 'quota']) {
  test(`ICAO ${mode} keeps last-good closures and lets seed-meta age into STALE`, () => {
    const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: mode });
    assert.equal(state.icaoCalls, 1, stdout + stderr);
    assert.match(stderr, /\[NOTAM\] ICAO fetch failed: .* kept last-good closures/);
    assert.equal(state.writes.includes(NOTAM_KEY), false, 'an upstream failure must not overwrite last-good closures');
    assert.equal(state.writes.includes(NOTAM_META_KEY), false, 'an upstream failure must not refresh seed-meta');
    assert.deepEqual(state.notam.closedIcaos, ['OEDF']);
    assert.equal(state.meta.fetchedAt, state.initialFetchedAt);
    assert.ok(
      state.expires.some(([key, ttl]) => key === NOTAM_KEY && ttl === 7200),
      'last-good closures inside the health budget keep serving',
    );
    assert.equal(
      state.expires.some(([key]) => key === NOTAM_META_KEY),
      false,
      'seed-meta TTL is left alone so it cannot be shortened into an early miss',
    );
  });
}

test('ICAO failure past the health budget lets last-good closures expire', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'retired', TEST_META_AGE_MIN: '241' });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.match(stderr, /past maxStaleMin 240; letting them expire/);
  assert.equal(state.writes.includes(NOTAM_KEY), false);
  assert.equal(state.writes.includes(NOTAM_META_KEY), false);
  assert.equal(state.expires.some(([key]) => key === NOTAM_KEY), false);
});

test('the seeder retention budget equals the health budget for notamClosures', async () => {
  const { __testing__: health } = await import('../api/health.js');
  const source = readFileSync(join(root, 'scripts', 'seed-aviation.mjs'), 'utf8');
  const match = source.match(/const NOTAM_MAX_STALE_MIN = (\d+);/);
  assert.ok(match, 'seed-aviation.mjs must declare NOTAM_MAX_STALE_MIN');
  assert.equal(health.SEED_META.notamClosures.key, NOTAM_META_KEY);
  assert.equal(Number(match[1]), health.SEED_META.notamClosures.maxStaleMin);
});

test('ICAO success publishes classified closures and fresh seed-meta', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'ok' });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.match(stdout, /\[NOTAM\] wrote \d+ closures/);
  assert.deepEqual(state.notam.closedIcaos, ['OEJN']);
  assert.deepEqual(state.notam.restrictedIcaos, ['OEMA']);
  assert.equal(state.meta.recordCount, 2);
  assert.ok(state.meta.fetchedAt > state.initialFetchedAt);
});

test('ICAO success with no NOTAMs is a valid empty observation', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'okEmpty' });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.match(stdout, /\[NOTAM\] wrote \d+ closures/);
  assert.deepEqual(state.notam, { closedIcaos: [], restrictedIcaos: [], reasons: {}, coveredIcaos: [] });
  assert.equal(state.meta.recordCount, 0);
  assert.ok(state.meta.fetchedAt > state.initialFetchedAt);
});

// FAA NMS (seed-notam-nms.mjs) is a second closure source. Its snapshot covers
// every aerodrome; the side-car keeps only the airports it monitors.
test('ICAO outage with fresh NMS closures publishes the NMS observation', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'retired', TEST_NMS_MODE: 'fresh' });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.doesNotMatch(stderr, /kept last-good closures/);
  assert.deepEqual(state.notam.closedIcaos, ['OEJN'], 'KZZZ is not a monitored airport');
  assert.deepEqual(state.notam.restrictedIcaos.sort(), ['OEDF', 'OEMA']);
  assert.equal(state.notam.reasons.OEJN, 'AD CLSD (NMS)');
  assert.deepEqual(state.notam.coveredIcaos, ['EGKK', 'OEJN', 'OIIE'], 'coverage is limited to monitored airports');
  assert.ok(state.meta.fetchedAt > state.initialFetchedAt, 'NMS is a current observation');
  const notice = state.pushes.find((p) => p.eventType === 'notam_closure');
  assert.equal(notice?.payload.source, 'FAA NMS NOTAM');
});

// Khartoum and London Gatwick were listed only in src/config/airports.ts, which
// the Railway container does not ship, so their NMS closures and coverage were
// dropped. tests/aviation-notify-location.test.mjs keeps the registries aligned.
test('NMS closures and coverage reach airports that were dashboard-only', () => {
  const { state, stdout, stderr } = runAviation({ ICAO_API_KEY: '', TEST_NMS_MODE: 'dashboard' });
  assert.deepEqual(state.notam.closedIcaos.sort(), ['HSSK', 'OEJN']);
  assert.equal(state.notam.reasons.HSSK, 'AD CLSD');
  assert.ok(state.notam.coveredIcaos.includes('EGKK'));
  const notice = state.pushes.find((p) => p.eventType === 'notam_closure' && p.payload.coalesceKey === 'notam:closure:HSSK');
  assert.ok(notice, stdout + stderr);
  assert.equal(notice.payload.countryCode, 'SD');
  assert.equal(typeof notice.payload.lat, 'number');
  assert.doesNotMatch(stderr, /notam_closure HSSK: no registry country/);
});

test('without an ICAO key, fresh NMS closures still publish', () => {
  const { state, stdout, stderr } = runAviation({ ICAO_API_KEY: '', TEST_NMS_MODE: 'fresh' });
  assert.equal(state.icaoCalls, 0, stdout + stderr);
  assert.deepEqual(state.notam.closedIcaos, ['OEJN']);
  assert.equal(state.meta.recordCount, 3);
});

// Closed-beats-restricted across sources: tests/notam-nms.test.mjs mergeClosureSources.
test('ICAO and NMS closures merge and NMS reasons win', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'ok', TEST_NMS_MODE: 'fresh' });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.deepEqual(state.notam.closedIcaos, ['OEJN']);
  assert.deepEqual(state.notam.restrictedIcaos.sort(), ['OEDF', 'OEMA']);
  assert.equal(state.notam.reasons.OEMA, 'RESTRICTED (NMS)');
});

// Once NMS has published in production it is the primary closure source. A
// stale or expired NMS snapshot must not let an empty ICAO answer (the feed has
// returned nothing since 2026-10-19) publish "no closures" as current: that
// clears notam:prev-closed-state:v1, so every standing closure re-notifies when
// NMS recovers.
for (const nmsMode of ['stale', '']) {
  test(`activated NMS ${nmsMode || 'missing'}: an empty ICAO answer keeps last-good closures`, () => {
    const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'okEmpty', TEST_NMS_MODE: nmsMode, TEST_NMS_ACTIVATED: '1' });
    assert.equal(state.icaoCalls, 1, stdout + stderr);
    assert.match(stderr, /FAA NMS closures are not current.* kept last-good closures/);
    assert.equal(state.writes.includes(NOTAM_KEY), false);
    assert.equal(state.writes.includes(NOTAM_META_KEY), false, 'seed-meta ages into STALE');
    assert.equal(state.writes.includes('notam:prev-closed-state:v1'), false);
    assert.deepEqual(state.notam.closedIcaos, ['OEDF']);
  });
}

test('an unreadable activation marker counts as activated: an empty ICAO answer keeps last-good', () => {
  const { state, stdout, stderr } = runAviation({
    TEST_ICAO_MODE: 'okEmpty',
    TEST_REDIS_FAIL_KEYS: 'seed-activated:aviation:notam-nms:v1,aviation:notam:nms:closures:v1',
  });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.match(stderr, /FAA NMS closures are not current.* kept last-good closures/);
  assert.equal(state.writes.includes(NOTAM_KEY), false);
  assert.equal(state.writes.includes('notam:prev-closed-state:v1'), false);
  assert.deepEqual(state.notam.closedIcaos, ['OEDF']);
});

test('before NMS activation an empty ICAO answer is still a valid observation', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'okEmpty', TEST_NMS_MODE: 'stale' });
  assert.equal(state.icaoCalls, 1, stdout + stderr);
  assert.deepEqual(state.notam, { closedIcaos: [], restrictedIcaos: [], reasons: {}, coveredIcaos: [] });
});

test('stale NMS closures are ignored: an ICAO outage still keeps last-good', () => {
  const { state, stdout, stderr } = runAviation({ TEST_ICAO_MODE: 'retired', TEST_NMS_MODE: 'stale' });
  assert.match(stderr, /kept last-good closures/, stdout + stderr);
  assert.equal(state.writes.includes(NOTAM_KEY), false);
  assert.deepEqual(state.notam.closedIcaos, ['OEDF']);
});
