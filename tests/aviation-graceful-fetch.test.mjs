import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { AVIATIONSTACK_LIST } from '../scripts/seed-aviation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const preload = `
const intlKey = 'aviation:delays:intl:v3';
const metaKey = 'seed-meta:aviation:intl';
const fetchedAt = Date.now() - Number(process.env.TEST_META_AGE_MIN ?? 30) * 60_000;
const lastGood = {
  _seed: { fetchedAt, recordCount: 0, state: 'OK_ZERO' },
  data: { alerts: [], coverage: [{ iata: 'PEK', status: 'normal', flightCount: 8, updatedAt: fetchedAt }] },
};
const lastMeta = { fetchedAt, recordCount: 0 };
const values = new Map([
  [intlKey, JSON.stringify(lastGood)],
  [metaKey, JSON.stringify(lastMeta)],
]);
if (process.env.TEST_MISSING_KEY) values.delete(process.env.TEST_MISSING_KEY);
const writes = [];
const expires = [];
let providerCalls = 0;
const command = ([verb, key, value, ...args]) => {
  if (verb === 'GET') return values.get(key) ?? null;
  if (verb === 'SET') {
    writes.push(key);
    if (args.includes('NX') && values.has(key)) return null;
    values.set(key, value);
    return 'OK';
  }
  if (verb === 'EXPIRE') {
    expires.push([key, value]);
    return values.has(key) ? 1 : 0;
  }
  if (verb === 'EVAL') {
    values.delete(args[0]);
    return 1;
  }
  throw new Error('Unexpected Redis command ' + verb);
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'seed-test.invalid') {
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      return Response.json({ result: values.get(key) ?? null });
    }
    const body = JSON.parse(options.body);
    if (url.pathname === '/pipeline') {
      if (process.env.TEST_RETENTION_FAILURE && body.some(([verb, key]) => verb === 'EXPIRE' && key === intlKey)) {
        return new Response('denied', { status: 403 });
      }
      return Response.json(body.map(item => ({ result: command(item) })));
    }
    return Response.json({ result: command(body) });
  }
  if (url.hostname === 'api.aviationstack.com') {
    providerCalls++;
    const authError = { error: { code: 'invalid_access_key', message: 'You have not supplied a valid API Access Key.' } };
    if (process.env.TEST_PROVIDER_MODE === 'http401') return Response.json(authError, { status: 401 });
    if (process.env.TEST_PROVIDER_MODE === 'jsonAuth') return Response.json(authError);
    throw new TypeError('fetch failed', { cause: new Error('fixture connection reset') });
  }
  throw new Error('fixture source unavailable');
};
process.on('exit', () => {
  console.log('FIXTURE_STATE=' + JSON.stringify({
    providerCalls, writes, expires, initialFetchedAt: fetchedAt,
    intl: JSON.parse(values.get(intlKey) ?? 'null'),
    meta: JSON.parse(values.get(metaKey) ?? 'null'),
    lockHeld: values.has('seed-lock:aviation:intl'),
  }));
});
`;

function runAviation(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aviation-graceful-'));
  const path = join(directory, 'preload.mjs');
  writeFileSync(path, preload);
  // An explicit empty env file stops loadEnvFile from pulling a developer's
  // .env.local into the child, so only the fixture env below is in effect.
  const envFile = join(directory, 'empty.env');
  writeFileSync(envFile, '');
  try {
    const result = spawnSync(process.execPath, ['--import', path, 'seed-aviation.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        AVIATIONSTACK_API: 'fixture-key',
        AVIATIONSTACK_MONTHLY_BUDGET: '0',
        AVIATIONSTACK_MIN_REFRESH_MIN: '0',
        WM_SEED_RETRY_DELAY_MS: '0',
        WM_SEED_ENV_FILE: envFile,
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    const stateLine = result.stdout.split('\n').find(line => line.startsWith('FIXTURE_STATE='));
    assert.ok(stateLine, result.stdout + result.stderr);
    return { ...result, state: JSON.parse(stateLine.slice('FIXTURE_STATE='.length)) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('aviation command completes a failed refresh when last-good retention is confirmed', () => {
  const result = runAviation();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /intl unpublishable: systemic fetch failure/);
  assert.match(result.stderr, /last-good is 30min old \(maxStaleMin 90\); exiting 0/);
  assert.doesNotMatch(result.stdout, /"event":"seed_complete"/);
  assert.match(result.stdout, /=== Refresh failed; last-good retained/);
  assert.doesNotMatch(result.stdout, /=== Failed gracefully/);
  assert.equal(result.state.providerCalls, AVIATIONSTACK_LIST.length, 'a failed sweep must not repeat paid calls');
  const { initialFetchedAt } = result.state;
  assert.equal(result.state.intl._seed.fetchedAt, initialFetchedAt);
  assert.equal(result.state.meta.fetchedAt, initialFetchedAt);
  assert.deepEqual(result.state.intl.data.coverage, [
    { iata: 'PEK', status: 'normal', flightCount: 8, updatedAt: initialFetchedAt },
  ]);
  assert.equal(result.state.writes.includes('aviation:delays:intl:v3'), false);
  assert.equal(result.state.writes.includes('seed-meta:aviation:intl'), false);
  assert.ok(result.state.writes.includes('aviation:delays-bootstrap:v2'));
  assert.ok(result.state.expires.some(([key, ttl]) => key === 'aviation:delays:intl:v3' && ttl === 10800));
  assert.ok(result.state.expires.some(([key, ttl]) => key === 'seed-meta:aviation:intl' && ttl === 10800));
  assert.equal(result.state.lockHeld, false);
});

for (const missingKey of ['aviation:delays:intl:v3', 'seed-meta:aviation:intl']) {
  test(`aviation command still fails when ${missingKey} is missing`, () => {
    const result = runAviation({ TEST_MISSING_KEY: missingKey });
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.match(result.stdout, /Failed gracefully/);
    assert.equal(result.state.providerCalls, AVIATIONSTACK_LIST.length);
  });
}

test('aviation command still fails when Redis cannot confirm last-good retention', () => {
  const result = runAviation({ TEST_RETENTION_FAILURE: '1' });
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.match(result.stderr, /TTL extension pipeline failed/);
  assert.equal(result.state.providerCalls, AVIATIONSTACK_LIST.length);
});

test('aviation command still fails when last-good is older than maxStaleMin', () => {
  const result = runAviation({ TEST_META_AGE_MIN: '91' });
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.match(result.stderr, /last-good age 91min is not within maxStaleMin 90/);
  assert.match(result.stdout, /=== Failed gracefully/);
  assert.equal(result.state.providerCalls, AVIATIONSTACK_LIST.length);
});

test('aviation command still fails when the AviationStack key is missing', () => {
  const result = runAviation({ AVIATIONSTACK_API: '' });
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.match(result.stderr, /intl unpublishable: no AVIATIONSTACK_API key/);
  assert.match(result.stdout, /=== Failed gracefully/);
  assert.equal(result.state.providerCalls, 0);
});

for (const mode of ['http401', 'jsonAuth']) {
  test(`aviation command still fails when AviationStack rejects the key (${mode})`, () => {
    const result = runAviation({ TEST_PROVIDER_MODE: mode });
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.match(result.stderr, /intl unpublishable: AviationStack rejected the key on \d+ airport\(s\)/);
    assert.match(result.stdout, /=== Failed gracefully/);
    assert.equal(result.state.providerCalls, AVIATIONSTACK_LIST.length);
  });
}
