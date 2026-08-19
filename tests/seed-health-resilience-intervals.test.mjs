import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import sovereignStatus from '../scripts/shared/sovereign-status.json' with { type: 'json' };

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
  RESILIENCE_SCHEMA_V2_ENABLED: process.env.RESILIENCE_SCHEMA_V2_ENABLED,
  RESILIENCE_EDUCATION_ENABLED: process.env.RESILIENCE_EDUCATION_ENABLED,
};

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
process.env.RESILIENCE_EDUCATION_ENABLED = 'true';

const { default: handler } = await import('../api/seed-health.js');

const META_KEY = 'seed-meta:resilience:intervals';
const PROBE_KEY = 'resilience:intervals:v11:US';
const EDUCATION_META_KEY = 'seed-meta:resilience:education-attainment';
const EDUCATION_DATA_KEY = 'resilience:education-attainment:v1';
const METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const SOURCE_VERSION = `resilience-intervals:resilience:intervals:v11:${METHODOLOGY}`;

function intervalMeta(overrides = {}) {
  return {
    fetchedAt: Date.now(),
    recordCount: 196,
    sourceVersion: SOURCE_VERSION,
    ...overrides,
  };
}

function intervalPayload(overrides = {}) {
  return {
    p05: 65.2,
    p95: 72.8,
    _formula: 'pc',
    _educationState: 'education-on',
    computedAt: '2026-06-04T18:03:20.983Z',
    methodology: METHODOLOGY,
    ...overrides,
  };
}

function educationPayload(count = 180) {
  return {
    countries: Object.fromEntries(
      sovereignStatus.entries.slice(0, count).map((entry, index) => [
        entry.iso2,
        { value: 20 + (index % 75), year: 2024 },
      ]),
    ),
  };
}

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function installPipelineMock(values) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map((command) => {
      const [op, key] = command;
      // #4927: activation-gated entries add EXISTS probes on their
      // seed-activated:* markers; absent unless a test seeds them.
      if (op === 'EXISTS') {
        // military:bases is the one activation key outside the seed-activated:*
        // namespace: it gates on its active-version pointer (#6845).
        assert.match(
          String(key),
          /^seed-activated:|^military:bases:active$/,
          'EXISTS is only used for activation markers',
        );
        return { result: values.has(key) ? 1 : 0 };
      }
      assert.equal(op, 'GET');
      const value = values.has(key)
        ? values.get(key)
        : key === EDUCATION_META_KEY
          ? { fetchedAt: Date.now(), recordCount: 187, rankableRecordCount: 180, sourceVersion: 'test' }
        : key === EDUCATION_DATA_KEY
          ? educationPayload()
        : String(key).startsWith('seed-meta:')
          ? { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'test' }
          : null;
      return { result: value == null ? null : JSON.stringify(value) };
    });
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('seed-health enforces the active education rankable coverage floor', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload()],
    [EDUCATION_META_KEY, {
      fetchedAt: Date.now(),
      recordCount: 187,
      rankableRecordCount: 179,
      sourceVersion: 'wb-education-2026',
    }],
  ]));

  const { body } = await readSeedHealth();
  const entry = body.seeds['resilience:education-attainment'];
  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.stale, true);
  assert.equal(entry.rankableRecordCount, 179);
  assert.equal(entry.minRankableRecordCount, 180);

  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload()],
    [EDUCATION_META_KEY, {
      fetchedAt: Date.now(),
      recordCount: 187,
      rankableRecordCount: 180,
      sourceVersion: 'wb-education-2026',
    }],
  ]));
  const healthy = await readSeedHealth();
  assert.equal(healthy.body.seeds['resilience:education-attainment'].status, 'ok');
});

test('seed-health applies strict countrySet transition coverage', async () => {
  const codes = sovereignStatus.entries.map((entry) => entry.iso2);
  const readWithCountrySet = async (countrySet) => {
    installPipelineMock(new Map([
      [META_KEY, intervalMeta()],
      [PROBE_KEY, intervalPayload()],
      [EDUCATION_META_KEY, {
        fetchedAt: Date.now(),
        recordCount: 187,
        countrySet,
        sourceVersion: 'wb-education-transition',
      }],
    ]));
    return readSeedHealth();
  };

  const healthy = await readWithCountrySet(codes.slice(0, 180).join(','));
  assert.equal(healthy.body.seeds['resilience:education-attainment'].status, 'ok');

  const duplicated = await readWithCountrySet([...codes.slice(0, 179), codes[0]].join(','));
  assert.equal(duplicated.body.seeds['resilience:education-attainment'].status, 'coverage_partial');
  assert.equal(duplicated.body.seeds['resilience:education-attainment'].rankableRecordCount, 179);

  const lowercase = await readWithCountrySet(`${codes.slice(0, 179).join(',')},fr`);
  assert.equal(lowercase.body.seeds['resilience:education-attainment'].status, 'coverage_partial');
  assert.equal(lowercase.body.seeds['resilience:education-attainment'].rankableRecordCount, null);
});

test('seed-health trusts canonical education payload coverage over stale metadata', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload()],
    [EDUCATION_META_KEY, {
      fetchedAt: Date.now() - 60_000,
      recordCount: 187,
      rankableRecordCount: 180,
      sourceVersion: 'old-healthy-meta',
    }],
    [EDUCATION_DATA_KEY, educationPayload(179)],
  ]));

  const { body } = await readSeedHealth();
  const entry = body.seeds['resilience:education-attainment'];
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.dataProbe.rankableRecordCount, 179);
  assert.equal(entry.dataProbe.minRankableRecordCount, 180);
});

async function readSeedHealth() {
  const req = new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
  const res = await handler(req);
  const body = await res.json();
  return { res, body };
}

test('seed-health flags fresh resilience interval meta when the current v11 data probe is absent', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'data_missing');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.equal(body.seeds['resilience:intervals'].recordCount, 196);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'data_missing',
    key: PROBE_KEY,
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
    requiredFormula: 'pc',
    requiredEducationState: 'education-on',
  });
});

test('seed-health keeps resilience intervals green when fresh meta matches the current probe methodology', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload()],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.seeds['resilience:intervals'].status, 'ok');
  assert.equal(body.seeds['resilience:intervals'].stale, false);
  assert.equal(body.seeds['resilience:intervals'].sourceVersion, SOURCE_VERSION);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.ok, true);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.key, PROBE_KEY);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.methodology, METHODOLOGY);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.formula, 'pc');
  assert.equal(body.seeds['resilience:intervals'].dataProbe.requiredFormula, 'pc');
  assert.equal(body.seeds['resilience:intervals'].dataProbe.requiredEducationState, 'education-on');
});

test('seed-health resilience formula defaults active and only explicit false selects rollback', async () => {
  const original = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
  try {
    for (const { raw, formula } of [
      { raw: undefined, formula: 'pc' },
      { raw: 'true', formula: 'pc' },
      { raw: 'false', formula: 'd6' },
    ]) {
      if (raw === undefined) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
      else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = raw;
      installPipelineMock(new Map([
        [META_KEY, intervalMeta()],
        [PROBE_KEY, intervalPayload({ _formula: formula })],
      ]));

      const { body } = await readSeedHealth();
      const interval = body.seeds['resilience:intervals'];
      assert.equal(interval.status, 'ok', `pillar=${String(raw)} must accept ${formula}`);
      assert.equal(interval.dataProbe.requiredFormula, formula);
    }
  } finally {
    if (original == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
    else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = original;
  }
});

test('seed-health flags resilience interval metadata below the publication floor', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta({ recordCount: 179 })],
    [PROBE_KEY, intervalPayload()],
  ]));

  const { body } = await readSeedHealth();
  const interval = body.seeds['resilience:intervals'];
  assert.equal(interval.status, 'coverage_partial');
  assert.equal(interval.stale, true);
  assert.equal(interval.recordCount, 179);
  assert.equal(interval.minRecordCount, 180);
});

test('seed-health flags resilience interval methodology mismatches', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload({ _formula: 'd6', methodology: 'weight-perturbation-sensitivity-v2' })],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'methodology_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'methodology_mismatch',
    key: PROBE_KEY,
    methodology: 'weight-perturbation-sensitivity-v2',
    formula: 'd6',
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
    requiredFormula: 'pc',
    educationState: 'education-on',
    requiredEducationState: 'education-on',
  });
});

test('seed-health flags resilience interval formula mismatches even when meta is fresh', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload({ _formula: 'd6' })],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'formula_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'formula_mismatch',
    key: PROBE_KEY,
    formula: 'd6',
    requiredFormula: 'pc',
    educationState: 'education-on',
    requiredEducationState: 'education-on',
    methodology: METHODOLOGY,
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
  });
});

test('seed-health flags resilience interval education-state mismatches', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload({ _educationState: 'education-off' })],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'construct_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'construct_mismatch',
    key: PROBE_KEY,
    formula: 'pc',
    requiredFormula: 'pc',
    educationState: 'education-off',
    requiredEducationState: 'education-on',
    methodology: METHODOLOGY,
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
  });
});

test('seed-health rejects untagged resilience interval construct state', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload({ _educationState: undefined })],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'construct_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'construct_mismatch',
    key: PROBE_KEY,
    formula: 'pc',
    requiredFormula: 'pc',
    educationState: null,
    requiredEducationState: 'education-on',
    methodology: METHODOLOGY,
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
  });
});

test('seed-health flags malformed resilience interval payloads even when meta is fresh', async () => {
  const cases = [
    { name: 'missing p05', payload: intervalPayload({ p05: undefined }), p05: null, p95: 72.8 },
    { name: 'non-finite p95', payload: intervalPayload({ p95: Number.POSITIVE_INFINITY }), p05: 65.2, p95: null },
    { name: 'reversed bounds', payload: intervalPayload({ p05: 80, p95: 70 }), p05: 80, p95: 70 },
    { name: 'p05 below range', payload: intervalPayload({ p05: -1, p95: 70 }), p05: -1, p95: 70 },
    { name: 'p95 above range', payload: intervalPayload({ p05: 65, p95: 101 }), p05: 65, p95: 101 },
  ];

  for (const item of cases) {
    installPipelineMock(new Map([
      [META_KEY, intervalMeta()],
      [PROBE_KEY, item.payload],
    ]));

    const { res, body } = await readSeedHealth();

    assert.equal(res.status, 200, item.name);
    assert.equal(body.overall, 'warning', item.name);
    assert.equal(body.seeds['resilience:intervals'].status, 'data_invalid', item.name);
    assert.equal(body.seeds['resilience:intervals'].stale, true, item.name);
    assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
      ok: false,
      status: 'data_invalid',
      key: PROBE_KEY,
      formula: 'pc',
      requiredFormula: 'pc',
      educationState: 'education-on',
      requiredEducationState: 'education-on',
      methodology: METHODOLOGY,
      requiredMethodology: METHODOLOGY,
      requiredSourceVersion: SOURCE_VERSION,
      p05: item.p05,
      p95: item.p95,
    }, item.name);
  }
});

test('seed-health flags resilience interval source-version mismatches', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta({ sourceVersion: 'resilience-intervals:resilience:intervals:v7:old-methodology' })],
    [PROBE_KEY, intervalPayload()],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'source_version_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.equal(
    body.seeds['resilience:intervals'].sourceVersion,
    'resilience-intervals:resilience:intervals:v7:old-methodology',
  );
  assert.equal(body.seeds['resilience:intervals'].dataProbe.ok, true);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.requiredSourceVersion, SOURCE_VERSION);
});
