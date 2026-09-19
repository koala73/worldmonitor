import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllHumanitarianSummaries, HAPI_REQUIRED_COUNTRIES } from '../scripts/seed-conflict-intel.mjs';
import { __testing__ } from '../api/health.js';

const NOW = Date.parse('2026-09-17T13:40:00Z');
const SUCCESS = NOW - 144 * 60_000;
const marker = {
  updatedAt: SUCCESS,
  sourceChannel: 'hdx-snapshot',
  countriesCovered: 44,
  requiredCountriesTotal: HAPI_REQUIRED_COUNTRIES.length,
  requiredCountriesCovered: HAPI_REQUIRED_COUNTRIES.length,
  requiredCountryCodes: [...HAPI_REQUIRED_COUNTRIES].sort(),
};

async function failedRefresh(overrides = {}) {
  let meta;
  let backoff;
  await fetchAllHumanitarianSummaries({
    now: () => NOW,
    readElapsedMs: () => 0,
    pace: async () => {},
    loadPreviousMarker: async () => marker,
    loadFailureBackoff: async () => null,
    snapshotFetchFn: async () => { throw new DOMException('timeout', 'TimeoutError'); },
    fetchFn: async () => new Response('quota', { status: 429 }),
    writeFailureMeta: async (value) => { meta = value; },
    writeFailureBackoff: async (value) => { backoff = value; },
    preserveLastGood: async () => {},
    ...overrides,
  });
  return { meta, backoff };
}

function classify(meta, retention, now = NOW) {
  const { classifyKey, STANDALONE_KEYS, SEED_META, isContainedHealthWarning } = __testing__;
  const name = 'humanitarianSummary';
  const key = STANDALONE_KEYS[name];
  const evidence = new Map();
  const entry = classifyKey(name, key, {}, {
    now,
    keyStrens: new Map([[key, 2048]]), keyErrors: new Map(),
    keyMetaValues: new Map([[SEED_META[name].key, JSON.stringify(meta)]]), keyMetaErrors: new Map(),
    humanitarianRetention: retention,
    containmentEvidenceByName: evidence,
  });
  return { entry, contained: isContainedHealthWarning(entry, evidence.get(name), now) };
}

test('failed HDX refresh and API quota rejection keep the genuine success age', async () => {
  const { meta } = await failedRefresh();
  const { entry } = classify(meta);
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.errorCode, 'HAPI_RATE_LIMIT');
  assert.equal(entry.seedAgeMin, 144);
  assert.equal(meta.fetchedAt, SUCCESS);
  assert.equal(meta.lastSourceAttemptAt, NOW);
});

async function retention(meta, mutate = () => {}, now = NOW) {
  const { readHumanitarianRetention } = await import('../api/_humanitarian-retention.js');
  const data = new Map([[ 'conflict:humanitarian:v1', marker ]]);
  const ttls = new Map();
  for (const countryCode of HAPI_REQUIRED_COUNTRIES) {
    const key = `conflict:humanitarian:v1:${countryCode}`;
    data.set(key, { summary: {
      countryCode, countryName: countryCode, referencePeriod: '2026-09-01', updatedAt: SUCCESS,
      conflictEventsTotal: 12, conflictPoliticalViolenceEvents: 10,
      conflictFatalities: 3, conflictDemonstrations: 2,
    } });
    ttls.set(key, 6 * 60 * 60_000 - (now - SUCCESS));
  }
  const state = { data, ttls, error: false, truncate: false };
  mutate(state);
  return readHumanitarianRetention(meta, 41, now, async (commands, timeout, raw) => {
    assert.equal(timeout, 4000);
    assert.equal(raw, true, 'read the raw seeder namespace used by the RPCs');
    const results = commands.map(([op, key]) => state.error ? { error: 'unavailable' }
      : { result: op === 'GET' ? JSON.stringify(data.get(key) ?? null) : ttls.get(key) ?? -2 });
    return state.truncate ? results.slice(0, -1) : results;
  });
}

test('real failure publisher and live country proof contain only complete retained data', async () => {
  const { meta, backoff } = await failedRefresh();
  const proof = await retention(meta);
  const { entry, contained } = classify(meta, proof);
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.records, 41);
  assert.equal(entry.seedAgeMin, 144);
  assert.equal(entry.lastSourceAttemptAt, NOW);
  assert.equal(entry.lastSuccessAt, SUCCESS);
  assert.equal(entry.retryAt, backoff.retryAt);
  assert.equal(contained, true);
  assert.equal(entry.containmentUntil, new Date(SUCCESS + 6 * 60 * 60_000).toISOString());
  assert.equal(__testing__.computeOverallStatus({ warn: 1, containedWarn: 1, onDemandWarn: 0, crit: 0 }, 293).overall, 'HEALTHY');
});

const firstKey = `conflict:humanitarian:v1:${HAPI_REQUIRED_COUNTRIES[0]}`;
for (const [label, mutate] of [
  ['missing country', ({ data }) => data.delete(firstKey)],
  ['missing summary', ({ data }) => data.set(firstKey, {})],
  ['wrong country', ({ data }) => { data.get(firstKey).summary.countryCode = 'ZZ'; }],
  ['malformed counts', ({ data }) => { data.get(firstKey).summary.conflictFatalities = '3'; }],
  ['invalid reference date', ({ data }) => { data.get(firstKey).summary.referencePeriod = '2026-02-30'; }],
  ['missing validity', ({ data }) => { delete data.get(firstKey).summary.updatedAt; }],
  ['future data', ({ data }) => { data.get(firstKey).summary.updatedAt = NOW + 1; }],
  ['expired country', ({ ttls }) => ttls.set(firstKey, -2)],
  ['unbounded TTL', ({ ttls }) => ttls.set(firstKey, -1)],
  ['unknown TTL', ({ ttls }) => ttls.set(firstKey, null)],
  ['missing marker', ({ data }) => data.delete('conflict:humanitarian:v1')],
  ['changed contract', ({ data }) => data.set('conflict:humanitarian:v1', { ...marker, requiredCountryCodes: marker.requiredCountryCodes.map((c, i) => i ? c : 'ZZ') })],
  ['redis error', (state) => { state.error = true; }],
  ['truncated response', (state) => { state.truncate = true; }],
]) {
  test(`retained humanitarian ${label} stays actionable`, async () => {
    const { meta } = await failedRefresh();
    const proof = await retention(meta, mutate);
    assert.equal(proof, null);
    const result = classify(meta, proof);
    assert.equal(result.entry.status, 'SEED_ERROR');
    assert.equal(result.contained, false);
  });
}

test('retention and cached health expire at the original deadline even with extended Redis TTL', async () => {
  const { meta } = await failedRefresh();
  const until = SUCCESS + 6 * 60 * 60_000;
  const extend = ({ ttls }) => { for (const key of ttls.keys()) ttls.set(key, 6 * 60 * 60_000); };
  const proof = await retention(meta, extend, until - 1);
  assert.equal(proof.until, until);
  assert.equal(classify(meta, proof, until - 1).contained, true);
  assert.equal(classify(meta, proof, until).contained, false);
  assert.equal(await retention(meta, extend, until), null);
});

test('no previous success or malformed contract never gains containment', async () => {
  const { meta } = await failedRefresh({ loadPreviousMarker: async () => null });
  assert.equal(meta.status, 'error');
  assert.equal(meta.lastSuccessAt, undefined);
  assert.equal(classify(meta, await retention(meta)).contained, false);
  const { meta: retained } = await failedRefresh();
  for (const change of [
    { requiredCountryCodes: undefined }, { requiredCountryCodes: Array(41).fill('SD') },
    { fetchedAt: NOW + 1 }, { lastSuccessAt: SUCCESS - 1 }, { fetchedAt: null },
  ]) assert.equal(await retention({ ...retained, ...change }), null);
});

test('country TTL can shorten but cannot renew containment', async () => {
  const { meta } = await failedRefresh();
  const proof = await retention(meta, ({ ttls }) => ttls.set(firstKey, 1000));
  assert.equal(proof.until, NOW + 1000);
  assert.equal(classify(meta, proof, NOW + 1000).contained, false);
});

test('API cooldown allows bounded HDX-only probes without changing success or quota deadlines', async () => {
  const first = await failedRefresh();
  let meta = first.meta;
  let backoff = first.backoff;
  let now = NOW;
  let snapshotCalls = 0;
  let apiCalls = 0;
  const tick = (snapshotFetchFn = async () => {
    snapshotCalls += 1;
    throw new DOMException('timeout', 'TimeoutError');
  }) => fetchAllHumanitarianSummaries({
    now: () => now, readElapsedMs: () => 0, pace: async () => {},
    loadPreviousMarker: async () => marker,
    loadFailureBackoff: async () => backoff,
    writeFailureBackoff: async (value) => { backoff = value; },
    writeFailureMeta: async (value) => { meta = value; },
    preserveLastGood: async () => {},
    snapshotFetchFn,
    fetchFn: async () => { apiCalls += 1; throw new Error('API disabled'); },
  });
  await tick();
  assert.equal(snapshotCalls, 0);
  const quotaDeadline = backoff.retryAt;
  const firstFailure = backoff.failedAt;
  now = backoff.nextSnapshotRetryAt;
  await tick();
  assert.equal(snapshotCalls, 1);
  assert.equal(apiCalls, 0);
  assert.equal(meta.fetchedAt, SUCCESS);
  assert.equal(meta.lastSourceAttemptAt, now);
  assert.equal(meta.errorCode, 'HAPI_RATE_LIMIT');
  assert.equal(meta.snapshotFailureReason, 'HDX_TIMEOUT');
  assert.equal(backoff.retryAt, quotaDeadline);
  assert.equal(backoff.failedAt, firstFailure);
  assert.equal(backoff.nextSnapshotRetryAt, now + 15 * 60_000);
  await tick();
  assert.equal(snapshotCalls, 1, 'repeated invocation in the same window is suppressed');
  now = backoff.nextSnapshotRetryAt;
  await tick();
  assert.equal(snapshotCalls, 2);
  assert.equal(meta.fetchedAt, SUCCESS);
  assert.equal(backoff.retryAt, quotaDeadline);
  assert.equal(apiCalls, 0);
});

test('slow snapshot-only failure cannot reset API backoff or launch the API', async () => {
  const first = await failedRefresh();
  let elapsed = 0;
  const now = first.backoff.nextSnapshotRetryAt;
  const { meta, backoff } = await failedRefresh({
    now: () => now,
    readElapsedMs: () => elapsed,
    loadFailureBackoff: async () => first.backoff,
    snapshotFetchFn: async () => { elapsed = 300_000; throw new DOMException('timeout', 'TimeoutError'); },
    fetchFn: async () => assert.fail('no API requests during cooldown'),
  });
  assert.equal(meta.errorCode, 'HAPI_RATE_LIMIT');
  assert.equal(meta.fetchedAt, SUCCESS);
  assert.equal(meta.lastSourceAttemptAt, now);
  assert.equal(backoff.retryAt, first.backoff.retryAt);
});

test('HDX recovery during API cooldown publishes a genuinely new success', async () => {
  const { backoff } = await failedRefresh();
  const now = backoff.nextSnapshotRetryAt;
  let calls = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => now, readElapsedMs: () => 0, pace: async () => {},
    countryCodes: ['SD'], requiredCountryCodes: ['SD'],
    loadPreviousMarker: async () => marker,
    loadFailureBackoff: async () => backoff,
    writeFailureBackoff: async (value) => assert.equal(value.retryAt, backoff.retryAt),
    writeFailureMeta: async () => assert.fail('recovery must not publish failure'),
    preserveLastGood: async () => assert.fail('recovery publishes new data'),
    fetchFn: async () => assert.fail('API must stay suppressed'),
    snapshotFetchFn: async (url) => {
      calls += 1;
      return String(url).includes('/api/3/action/package_show')
        ? Response.json({ success: true, result: { resources: [{ id: '2026', format: 'CSV', name: 'Global Coordination & Context: Conflict Events (2026)', url: 'https://data.humdata.org/dataset/example/resource/2026/download/hdx_hapi_conflict_event_global_2026.csv' }] } })
        : new Response('location_code,admin_level,event_type,events,fatalities,reference_period_start,reference_period_end\nSDN,0,political_violence,12,3,2026-09-01,2026-09-30');
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.sourceChannel, 'hdx-snapshot');
  assert.equal(result.snapshotFailureReason, null);
  assert.equal(result.summaries.SD.summary.updatedAt, now);
  assert.equal(result.summaries.SD.summary.conflictEventsTotal, 12);
});

test('full health sweep reads served countries and cannot retain containment across persistence expiry', async () => {
  const { handleHealth } = await import('../api/health.js');
  const { meta } = await failedRefresh();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const savedEnv = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';
  process.env.VERCEL_ENV = 'preview';
  let clock = NOW;
  let missing = false;
  let expireDuringWrite = false;
  let countryReads = 0;
  Date.now = () => clock;
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    return Response.json(commands.map(([op, key]) => {
      if (op === 'STRLEN') return { result: 2048 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'EXISTS') return { result: 0 };
      if (op === 'GET' && key === 'seed-meta:conflict:humanitarian') return { result: JSON.stringify(meta) };
      if (op === 'GET' && key === 'conflict:humanitarian:v1') return { result: JSON.stringify(marker) };
      if (key.startsWith('conflict:humanitarian:v1:')) {
        if (op === 'PTTL') return { result: 1000 };
        countryReads += 1;
        if (missing && key === firstKey) return { result: null };
        return { result: JSON.stringify({ summary: {
          countryCode: key.split(':').at(-1), countryName: 'Country', referencePeriod: '2026-09-01', updatedAt: SUCCESS,
          conflictEventsTotal: 12, conflictPoliticalViolenceEvents: 10, conflictFatalities: 3, conflictDemonstrations: 2,
        } }) };
      }
      if (op === 'GET' && key.includes('health:verdict:')) return { result: null };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: NOW, recordCount: 41 }) };
      if (op === 'SET' && key.includes('health:verdict:') && !key.endsWith(':refresh-lock') && expireDuringWrite) clock = NOW + 1001;
      return { result: 'OK' };
    }));
  };
  const sweep = async () => {
    clock = NOW;
    const response = await handleHealth(new Request('https://api.worldmonitor.app/api/health', {
      headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const valid = await sweep();
    assert.equal(countryReads, 41);
    assert.equal(valid.checks.humanitarianSummary.status, 'SEED_ERROR');
    assert.equal(valid.checks.humanitarianSummary.seedAgeMin, 144);
    assert.equal(valid.checks.humanitarianSummary.containmentUntil, new Date(NOW + 1000).toISOString());
    missing = true;
    const invalid = await sweep();
    assert.equal(invalid.summary.containedWarn, valid.summary.containedWarn - 1);
    assert.equal(invalid.checks.humanitarianSummary.containmentUntil, undefined);
    missing = false;
    expireDuringWrite = true;
    const expired = await sweep();
    assert.equal(expired.summary.containedWarn, invalid.summary.containedWarn);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

test('failed probe scheduling suppresses transport without moving failure or success clocks', async () => {
  const first = await failedRefresh();
  let calls = 0;
  const result = await fetchAllHumanitarianSummaries({
    now: () => first.backoff.nextSnapshotRetryAt,
    loadPreviousMarker: async () => marker,
    loadFailureBackoff: async () => first.backoff,
    writeFailureBackoff: async () => { throw new Error('Redis down'); },
    writeFailureMeta: async () => assert.fail('no source attempt occurred'),
    snapshotFetchFn: async () => { calls += 1; },
    fetchFn: async () => { calls += 1; },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
  assert.equal(first.meta.fetchedAt, SUCCESS);
  assert.equal(first.meta.lastSourceAttemptAt, NOW);
});

test('default failure preservation never renews country payload TTLs', async () => {
  const savedFetch = globalThis.fetch;
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const expires = [];
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    expires.push(...commands);
    return Response.json(commands.map(() => ({ result: 1 })));
  };
  try {
    const { meta } = await failedRefresh({ preserveLastGood: undefined });
    assert.equal(meta.fetchedAt, SUCCESS);
    assert.deepEqual(expires.map(([op, key]) => [op, key]), [
      ['EXPIRE', 'conflict:humanitarian:v1'], ['EXPIRE', 'seed-meta:conflict:humanitarian'],
    ]);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
  }
});
