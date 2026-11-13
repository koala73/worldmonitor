// The imaging catalog seeder keeps only profiled satellites, keeps a daily ring of prior
// elements, and never overwrites the stored catalog when CelesTrak refuses or matches nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { buildCatalog, mergeRing, RING_DAYS, utcDay } from '../scripts/_orbital-catalog.mjs';
import { ORBITAL_CATALOG_ACTIVATION_KEY, ORBITAL_CATALOG_KEY } from '../scripts/seed-orbital-catalog.mjs';
import { PUBLISH_BLOCKED_EXIT_CODE } from '../scripts/_seed-utils.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const META_KEY = 'seed-meta:orbital:catalog';
const COMPLETION_KEY = 'seed-completion:orbital:catalog';
const DAY_MS = 86_400_000;
const { records: fixtureRecords } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));

const PROFILED = fixtureRecords.slice(0, 10);
const UNPROFILED = Array.from({ length: 50 }, (_, i) => ({
  ...fixtureRecords[i % fixtureRecords.length],
  OBJECT_NAME: `STARLINK-${3000 + i}`,
  OBJECT_ID: `2023-${String(100 + i).padStart(3, '0')}A`,
  NORAD_CAT_ID: 80_000 + i,
}));
const ids = (list) => list.map((omm) => Number(omm.NORAD_CAT_ID)).sort((a, b) => a - b);

describe('catalog selection and ring', () => {
  const nowMs = Date.parse('2026-11-13T09:00:00Z');

  it('keeps exactly the profiled satellites from a mixed CelesTrak response', () => {
    const catalog = buildCatalog({ records: [...UNPROFILED, ...PROFILED], previous: null, nowMs });
    assert.deepEqual(catalog.satellites.map((s) => s.noradId), ids(PROFILED));
    assert.ok(catalog.satellites.every((s) => typeof s.profileId === 'string' && s.elements.NORAD_CAT_ID === s.noradId));
    assert.deepEqual(catalog.ring, [{ day: '2026-11-13', fetchedAt: nowMs, elements: catalog.satellites.map((s) => s.elements) }]);
  });

  it('appends one entry on a new day and replaces the entry on the same day', () => {
    const first = buildCatalog({ records: PROFILED, previous: null, nowMs: nowMs - DAY_MS });
    const nextDay = buildCatalog({ records: PROFILED, previous: first, nowMs });
    assert.deepEqual(nextDay.ring.map((d) => d.day), ['2026-11-12', '2026-11-13']);
    const sameDay = buildCatalog({ records: PROFILED.slice(0, 4), previous: nextDay, nowMs: nowMs + 3_600_000 });
    assert.deepEqual(sameDay.ring.map((d) => d.day), ['2026-11-12', '2026-11-13']);
    assert.equal(sameDay.ring[1].fetchedAt, nowMs + 3_600_000);
    assert.equal(sameDay.ring[1].elements.length, 4);
    assert.equal(sameDay.ring[0], nextDay.ring[0]);
  });

  it('drops ring entries older than the ring length', () => {
    const previousRing = Array.from({ length: 12 }, (_, i) => ({ day: utcDay(nowMs - (i + 1) * DAY_MS), fetchedAt: 0, elements: [] }));
    const ring = mergeRing(previousRing, { day: utcDay(nowMs), fetchedAt: nowMs, elements: [] });
    assert.equal(ring.length, RING_DAYS);
    assert.equal(ring[0].day, utcDay(nowMs - (RING_DAYS - 1) * DAY_MS));
    assert.equal(ring.at(-1).day, utcDay(nowMs));
  });

  it('keeps the newest epoch when CelesTrak lists a satellite twice', () => {
    const older = { ...PROFILED[0], EPOCH: '2026-11-01T00:00:00.000000' };
    const catalog = buildCatalog({ records: [PROFILED[0], older], previous: null, nowMs });
    assert.equal(catalog.satellites.length, 1);
    assert.equal(catalog.satellites[0].elements.EPOCH, PROFILED[0].EPOCH);
  });
});

const preload = `
import { readFileSync, writeFileSync } from 'node:fs';
const KEY = ${JSON.stringify(ORBITAL_CATALOG_KEY)};
const META_KEY = ${JSON.stringify(META_KEY)};
const ACTIVATION_KEY = ${JSON.stringify(ORBITAL_CATALOG_ACTIVATION_KEY)};
const COMPLETION_KEY = ${JSON.stringify(COMPLETION_KEY)};
const values = new Map();
if (process.env.TEST_LAST_GOOD) {
  const lastGood = JSON.parse(process.env.TEST_LAST_GOOD);
  values.set(KEY, JSON.stringify({ _seed: { fetchedAt: lastGood.fetchedAt, recordCount: lastGood.satellites.length, sourceVersion: 'x', schemaVersion: 1, state: 'OK' }, data: lastGood }));
  values.set(META_KEY, JSON.stringify({ fetchedAt: lastGood.fetchedAt, recordCount: lastGood.satellites.length }));
}
const initial = { canonical: values.get(KEY) ?? null, meta: values.get(META_KEY) ?? null };
const writes = [];
let celestrakCalls = 0;
let userAgent = null;
const evalScript = ([script, numKeys, ...rest]) => {
  const keys = rest.slice(0, Number(numKeys));
  const argv = rest.slice(Number(numKeys)).map(String);
  const current = values.get(keys[0]);
  if (!script.includes('PEXPIRE')) {
    if (current === argv[0]) { values.delete(keys[0]); return 1; }
    return 0;
  }
  if (current !== argv[0]) return [0, current ?? ''];
  if (keys.length === 2) { writes.push(keys[1]); values.set(keys[1], argv[2]); }
  return [1, ''];
};
const command = ([verb, key, value, ...args]) => {
  if (verb === 'EVAL') return evalScript([key, value, ...args]);
  if (verb === 'GET') return values.get(key) ?? null;
  if (verb === 'EXISTS') return values.has(key) ? 1 : 0;
  if (verb === 'SET') {
    if (args.includes('NX') && values.has(key)) return null;
    writes.push(key);
    values.set(key, value);
    return 'OK';
  }
  if (verb === 'EXPIRE' || verb === 'PEXPIRE') return values.has(key) ? 1 : 0;
  if (verb === 'DEL') { values.delete(key); return 1; }
  if (verb === 'TTL' || verb === 'PTTL') return values.has(key) ? 86400 : -2;
  throw new Error('Unexpected Redis command ' + verb);
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'seed-test.invalid') {
    if (url.pathname.startsWith('/get/')) return Response.json({ result: values.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
    const body = JSON.parse(options.body);
    if (url.pathname === '/pipeline' || url.pathname === '/multi-exec') return Response.json(body.map((item) => ({ result: command(item) })));
    return Response.json({ result: command(body) });
  }
  if (url.hostname === 'celestrak.org') {
    celestrakCalls++;
    userAgent = new Headers(options.headers).get('user-agent');
    if (process.env.TEST_MODE === 'forbidden') return new Response('GP data has not updated since your last successful download', { status: 403 });
    return new Response(readFileSync(process.env.TEST_CELESTRAK_FILE), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error('fixture source unavailable: ' + url.hostname);
};
process.on('exit', () => {
  writeFileSync(process.env.TEST_STATE_FILE, JSON.stringify({ writes, celestrakCalls, userAgent, initial, canonical: values.get(KEY) ?? null, meta: values.get(META_KEY) ?? null, completion: values.get(COMPLETION_KEY) ?? null, activation: values.get(ACTIVATION_KEY) ?? null }));
});
`;

function runSeeder({ mode = 'ok', records = [], lastGood = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-catalog-seed-'));
  const preloadPath = join(dir, 'preload.mjs');
  writeFileSync(preloadPath, preload);
  const envFile = join(dir, 'empty.env');
  writeFileSync(envFile, '');
  const celestrakFile = join(dir, 'celestrak.json');
  writeFileSync(celestrakFile, JSON.stringify(records));
  const stateFile = join(dir, 'state.json');
  try {
    const result = spawnSync(process.execPath, ['--import', preloadPath, 'seed-orbital-catalog.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        WM_SEED_RETRY_DELAY_MS: '0',
        WM_SEED_ENV_FILE: envFile,
        TEST_MODE: mode,
        TEST_CELESTRAK_FILE: celestrakFile,
        TEST_STATE_FILE: stateFile,
        ...(lastGood ? { TEST_LAST_GOOD: JSON.stringify(lastGood) } : {}),
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.ifError(result.error);
    assert.ok(existsSync(stateFile), result.stdout + result.stderr);
    return { ...result, fixture: JSON.parse(readFileSync(stateFile, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lastGoodCatalog() {
  const fetchedAt = Date.now() - 30 * 3_600_000;
  const satellite = { noradId: 40697, name: 'SENTINEL-2A', profileId: 'sentinel-2', elements: fixtureRecords[0] };
  return {
    schema: 1, inventoryVersion: 'last-good', source: 'x', fetchedAt, satellites: [satellite],
    ring: [
      { day: utcDay(Date.now() - 10 * DAY_MS), fetchedAt, elements: [fixtureRecords[0]] },
      { day: utcDay(Date.now() - DAY_MS), fetchedAt, elements: [fixtureRecords[0]] },
    ],
  };
}

describe('seed-orbital-catalog run', () => {
  it('publishes the profiled satellites, extends the ring and activates the health probe', () => {
    const r = runSeeder({ records: [...UNPROFILED, ...PROFILED], lastGood: lastGoodCatalog(), extraEnv: { WM_BUNDLE_COMPLETION_META_KEY: COMPLETION_KEY } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { canonical, meta, completion, activation, userAgent } = r.fixture;
    const envelope = JSON.parse(canonical);
    assert.deepEqual(envelope.data.satellites.map((s) => s.noradId), ids(PROFILED));
    assert.equal(envelope._seed.recordCount, PROFILED.length);
    assert.deepEqual(envelope.data.ring.map((d) => d.day), [utcDay(Date.now() - DAY_MS), utcDay(Date.now())]);
    assert.ok(JSON.parse(meta).fetchedAt > Date.now() - 60_000, 'seed-meta refreshed');
    assert.equal(activation, '1');
    assert.equal(JSON.parse(completion)?.fetchedAt, envelope._seed.fetchedAt, 'the bundle completion marker binds to this run');
    assert.match(userAgent, /WorldMonitor/);
  });

  it('exits publish-blocked on an upstream 403 and leaves the catalog and its ring unchanged', () => {
    const r = runSeeder({ mode: 'forbidden', lastGood: lastGoodCatalog() });
    assert.equal(r.status, PUBLISH_BLOCKED_EXIT_CODE, r.stdout + r.stderr);
    const { canonical, meta, initial, writes, activation, completion, celestrakCalls } = r.fixture;
    assert.equal(celestrakCalls, 1, 'a refusal is not retried');
    assert.equal(canonical, initial.canonical);
    assert.equal(meta, initial.meta);
    assert.ok(!writes.includes(ORBITAL_CATALOG_KEY) && !writes.includes(META_KEY), `writes ${writes}`);
    assert.equal(activation, null);
    assert.equal(completion, null);
  });

  it('does not overwrite the stored catalog when no object matches a profile', () => {
    const r = runSeeder({ records: UNPROFILED, lastGood: lastGoodCatalog() });
    assert.equal(r.status, PUBLISH_BLOCKED_EXIT_CODE, r.stdout + r.stderr);
    const { canonical, meta, initial, writes } = r.fixture;
    assert.equal(canonical, initial.canonical);
    assert.equal(meta, initial.meta);
    assert.ok(!writes.includes(ORBITAL_CATALOG_KEY), `writes ${writes}`);
  });
});
