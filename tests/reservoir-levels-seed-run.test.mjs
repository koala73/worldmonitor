// Runs the real reservoir seeder (runSeed, committed watchlist and baseline) against a
// fixture Redis, CMR and SlideRule, and checks what reaches Redis.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'climate:reservoir-levels:v1';
const STATE_KEY = 'climate:reservoir-levels:passes:v1';
const META_KEY = 'seed-meta:climate:reservoir-levels';
const COMPLETION_KEY = 'seed-completion:climate:reservoir-levels';
const ACTIVATION_KEY = 'seed-activated:climate:reservoir-levels';

const preload = `
import { writeFileSync } from 'node:fs';
const KEY = ${JSON.stringify(KEY)};
const STATE_KEY = ${JSON.stringify(STATE_KEY)};
const META_KEY = ${JSON.stringify(META_KEY)};
const COMPLETION_KEY = ${JSON.stringify(COMPLETION_KEY)};
const ACTIVATION_KEY = ${JSON.stringify(ACTIVATION_KEY)};
const initialFetchedAt = Date.now() - 30 * 3600_000;
const values = new Map();
if (process.env.TEST_LAST_GOOD) {
  values.set(KEY, JSON.stringify({ _seed: { fetchedAt: initialFetchedAt, recordCount: 1, sourceVersion: 'x', schemaVersion: 1, state: 'OK' }, data: { reservoirs: [{ id: 'last-good' }] } }));
  values.set(META_KEY, JSON.stringify({ fetchedAt: initialFetchedAt, recordCount: 1 }));
}
const writes = [];
let cmrCalls = 0;
let slideCalls = 0;
// The seed lock scripts in scripts/_seed-utils.mjs: compare-and-delete, renew, fenced SET.
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
  if (url.hostname === 'cmr.earthdata.nasa.gov') {
    cmrCalls++;
    if (process.env.TEST_MODE === 'outage') throw new TypeError('fetch failed', { cause: new Error('fixture connection reset') });
    return Response.json({ feed: { entry: [] } });
  }
  if (url.hostname === 'sliderule.slideruleearth.io') {
    slideCalls++;
    // A reachable cluster with nothing inside the core box: one alert event, no CSV.
    const msg = Buffer.from('no resources to process\0');
    const payload = Buffer.concat([Buffer.alloc(60), msg]);
    payload.writeUInt32LE(2, 8);
    const type = Buffer.from('eventrec\0');
    const header = Buffer.alloc(8);
    header.writeInt16BE(2, 0); header.writeInt16BE(type.length, 2); header.writeInt32BE(payload.length, 4);
    return new Response(Buffer.concat([header, type, payload]), { headers: { 'content-type': 'application/octet-stream' } });
  }
  throw new Error('fixture source unavailable: ' + url.hostname);
};
process.on('exit', () => {
  const parse = (k) => { const v = values.get(k); return v == null ? null : JSON.parse(v); };
  // A file, not stdout: a pipe write at exit is cut at 64 KB.
  writeFileSync(process.env.TEST_STATE_FILE, JSON.stringify({ writes, cmrCalls, slideCalls, initialFetchedAt, canonical: parse(KEY), state: parse(STATE_KEY), meta: parse(META_KEY), completion: parse(COMPLETION_KEY), activation: values.get(ACTIVATION_KEY) ?? null }));
});
`;

function runSeeder(mode, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reservoir-seed-'));
  const path = join(dir, 'preload.mjs');
  writeFileSync(path, preload);
  const envFile = join(dir, 'empty.env');
  writeFileSync(envFile, '');
  const stateFile = join(dir, 'state.json');
  try {
    const result = spawnSync(process.execPath, ['--import', path, 'seed-reservoir-levels.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        WM_SEED_RETRY_DELAY_MS: '0',
        WM_SEED_ENV_FILE: envFile,
        TEST_MODE: mode,
        TEST_STATE_FILE: stateFile,
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

test('a day with no new granules publishes the baseline metrics and refreshes seed-meta', () => {
  const r = runSeeder('quiet', { WM_BUNDLE_COMPLETION_META_KEY: COMPLETION_KEY });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { canonical, state, meta, completion, activation, slideCalls } = r.fixture;
  assert.ok(canonical?._seed, 'canonical key is enveloped');
  const reservoirs = canonical.data.reservoirs;
  assert.ok(reservoirs.length >= 30, `reservoirs ${reservoirs.length}`);
  assert.ok(reservoirs.filter((x) => x.latest).length >= Math.ceil(0.8 * reservoirs.length));
  assert.equal('_state' in canonical.data, false, 'state stays out of the canonical key');
  assert.ok(Object.keys(state.data?.byId ?? state.byId).length === reservoirs.length);
  assert.ok(meta.fetchedAt > Date.now() - 60_000, 'seed-meta refreshed');
  // The bundle's completion marker is written after the state key and binds to this run.
  assert.equal(completion?.fetchedAt, canonical._seed.fetchedAt);
  assert.equal(activation, '1', 'a successful publication writes the durable activation marker');
  // CMR lists no new granules and the baseline has no failed granules, so SlideRule is never called.
  assert.equal(slideCalls, 0);
});

test('a CMR outage keeps last-good, does not refresh seed-meta and exits with the graceful code', () => {
  const r = runSeeder('outage', { TEST_LAST_GOOD: '1' });
  assert.equal(r.status, 75, r.stdout + r.stderr);
  const { canonical, meta, writes, initialFetchedAt, activation } = r.fixture;
  assert.deepEqual(canonical.data.reservoirs, [{ id: 'last-good' }]);
  assert.equal(meta.fetchedAt, initialFetchedAt);
  assert.ok(!writes.includes(KEY) && !writes.includes(STATE_KEY), `writes ${writes}`);
  assert.equal(activation, null, 'a failed run never activates the probe');
});
