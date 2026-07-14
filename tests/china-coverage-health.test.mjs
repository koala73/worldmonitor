import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CHINA_COVERAGE_ENTRIES,
  CHINA_COVERAGE_CONTENT_STATUS,
  CHINA_COVERAGE_LAUNCH_STATUS,
  CHINA_COVERAGE_REASON_CODES,
  CHINA_COVERAGE_STATUS,
  CHINA_COVERAGE_SUMMARY_KEY,
  CHINA_COVERAGE_TRANSPORT_STATUS,
} from '../scripts/china-coverage-manifest.mjs';
import {
  chinaCoverageReadCommands,
  evaluateChinaCoverage,
  formatChinaCoverageHuman,
  readChinaCoverageInputs,
} from '../scripts/china-coverage-health.mjs';
import { chinaCoverageActivationCommand } from '../scripts/seed-china-coverage-health.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');

function singleEntry(overrides = {}) {
  return {
    id: 'test.china-row',
    label: 'Test China row',
    ownerIssue: 5271,
    launchStatus: 'launched',
    transport: {
      key: 'seed-meta:test',
      maxAgeMin: 60,
      timestampPaths: [['fetchedAt']],
    },
    content: {
      key: 'data:test',
      maxAgeMin: 180,
      probe: {
        kind: 'array-match',
        path: ['rows'],
        field: 'countryCode',
        values: ['CN'],
        timestampPaths: [['observedAt']],
      },
    },
    ...overrides,
  };
}

function evaluate(entry, data = {}, meta = {}) {
  return evaluateChinaCoverage({ entries: [entry], data, meta, now: NOW });
}

describe('China coverage manifest', () => {
  it('declares stable unique IDs for every required launched and planned lane', () => {
    const ids = CHINA_COVERAGE_ENTRIES.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'coverage IDs must be unique');
    assert.deepEqual(CHINA_COVERAGE_STATUS, ['healthy', 'degraded', 'unavailable', 'planned', 'blocked']);
    assert.ok(CHINA_COVERAGE_TRANSPORT_STATUS.includes('fresh'));
    assert.ok(CHINA_COVERAGE_CONTENT_STATUS.includes('partial'));
    assert.deepEqual(CHINA_COVERAGE_LAUNCH_STATUS, ['launched', 'planned', 'blocked']);

    for (const required of [
      'economic.bis-policy',
      'economic.imf-macro',
      'energy.jodi-oil',
      'energy.jodi-gas',
      'energy.spine',
      'trade.comtrade-reporter-156',
      'supply-chain.ccfi',
      'market.china-index',
      'news.china',
      'aviation.china-hubs',
      'macro.china-snapshot',
      'macro.china-release-calendar',
      'hazards.western-pacific-cyclones',
      'hazards.hko-warnings',
    ]) {
      assert.ok(ids.includes(required), `missing manifest entry ${required}`);
    }

    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'macro.china-snapshot')?.launchStatus,
      'launched',
    );
    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'macro.china-release-calendar')?.launchStatus,
      'launched',
    );
    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'hazards.hko-warnings')?.launchStatus,
      'launched',
    );
    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'hazards.western-pacific-cyclones')?.launchStatus,
      'launched',
    );
    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'aviation.china-hubs')?.transport.key,
      'seed-meta:aviation:intl',
    );
    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'aviation.china-hubs')?.launchStatus,
      'launched',
      'the canonical per-hub coverage contract is now provider-backed',
    );
    for (const id of ['energy.jodi-oil', 'energy.jodi-gas']) {
      assert.equal(
        CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === id)?.launchStatus,
        'blocked',
        `${id} must remain explicit until its source-specific China contract is available`,
      );
    }
    assert.equal(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'news.china')?.launchStatus,
      'launched',
      'China news is now backed by a source-specific projection, not global ranking',
    );
    assert.deepEqual(
      CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'aviation.china-hubs')?.content.probe,
      {
        kind: 'array-coverage',
        path: ['coverage'],
        field: 'iata',
        values: ['PEK', 'PVG', 'CAN', 'SZX', 'CTU', 'KMG', 'URC', 'HKG'],
        validField: 'status',
        validValues: ['normal', 'disruption'],
        timestampPaths: [['updatedAt']],
      },
    );
  });

  it('builds a read-only Redis audit pipeline', () => {
    const commands = chinaCoverageReadCommands(['one', 'two']);
    assert.deepEqual(commands, [['GET', 'one'], ['GET', 'two']]);
    assert.ok(commands.every(([command]) => command === 'GET'));
  });

  it('writes the activation marker durably without an expiry', () => {
    assert.deepEqual(
      chinaCoverageActivationCommand({ evaluatedAt: '2026-07-13T12:00:00.000Z' }),
      [
        'SET',
        'seed-activated:health:china-coverage',
        JSON.stringify({ activatedAt: '2026-07-13T12:00:00.000Z' }),
      ],
    );
  });

  it('keeps the Edge health key and status projection aligned with the manifest', () => {
    assert.equal(healthTesting.CHINA_COVERAGE_SUMMARY_KEY, CHINA_COVERAGE_SUMMARY_KEY);
    const projected = (status) => ({
      schemaVersion: 1,
      countryCode: 'CN',
      status,
      evaluatedAt: '2026-07-13T12:00:00.000Z',
      entries: [{
        id: 'test.china-row',
        launchStatus: 'launched',
        status,
        reasonCodes: status === 'healthy' ? [] : ['CHINA_ROW_MISSING'],
      }],
      counts: {
        total: 1,
        launched: 1,
        planned: 0,
        blocked: 0,
        healthy: status === 'healthy' ? 1 : 0,
        degraded: status === 'degraded' ? 1 : 0,
        unavailable: status === 'unavailable' ? 1 : 0,
      },
    });
    assert.equal(healthTesting.projectChinaCoverageStatus(projected('healthy')).status, 'OK');
    assert.equal(healthTesting.projectChinaCoverageStatus(projected('degraded')).status, 'CHINA_DEGRADED');
    assert.equal(healthTesting.projectChinaCoverageStatus(projected('unavailable')).status, 'CHINA_UNAVAILABLE');
    assert.equal(healthTesting.projectChinaCoverageStatus({
      ...projected('healthy'),
      entries: [],
      counts: {},
    }).reason, 'SUMMARY_INVALID');
    assert.equal(healthTesting.projectChinaCoverageStatus(projected('healthy'), true).status, 'REDIS_PARTIAL');

    const staleHealthy = healthTesting.composeChinaCoverageStatus(
      { status: 'STALE_SEED', records: 14, seedAgeMin: 181 },
      projected('healthy'),
    );
    assert.equal(staleHealthy.status, 'STALE_SEED');
    assert.equal(staleHealthy.chinaStatus, 'healthy');
    assert.equal(staleHealthy.seedStatus, 'STALE_SEED');

    const staleUnavailable = healthTesting.composeChinaCoverageStatus(
      { status: 'STALE_SEED', records: 14, seedAgeMin: 181 },
      projected('unavailable'),
    );
    assert.equal(staleUnavailable.status, 'CHINA_UNAVAILABLE');
    assert.equal(staleUnavailable.seedStatus, 'STALE_SEED');

    const failedDegraded = healthTesting.composeChinaCoverageStatus(
      { status: 'SEED_ERROR', records: 14 },
      projected('degraded'),
    );
    assert.equal(failedDegraded.status, 'CHINA_DEGRADED');
    assert.equal(failedDegraded.seedStatus, 'SEED_ERROR');

    const missing = healthTesting.composeChinaCoverageStatus(
      { status: 'EMPTY', records: 0 },
      projected('healthy'),
    );
    assert.deepEqual(missing, { status: 'EMPTY', records: 0 });
  });

  it('counts canonical provider coverage rather than synthetic aviation bootstrap filler', () => {
    const aviation = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'aviation.china-hubs');
    const alerts = ['PEK', 'PVG', 'CAN', 'HKG'].map((iata) => ({
      iata,
      severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
      updatedAt: NOW,
    }));
    const coverage = ['PEK', 'PVG', 'CAN', 'SZX', 'CTU', 'KMG', 'URC', 'HKG'].map((iata) => ({
      iata,
      status: 'normal',
      updatedAt: NOW,
    }));
    const result = evaluate(
      aviation,
      { 'aviation:delays-bootstrap:v2': { alerts, coverage } },
      { 'seed-meta:aviation:intl': { fetchedAt: NOW, status: 'ok' } },
    );

    assert.equal(result.entries[0].launchStatus, 'launched');
    assert.equal(result.entries[0].status, 'healthy');
    assert.equal(result.counts.launched, 1);
    assert.equal(result.counts.planned, 0);

    const providerFailure = evaluate(
      aviation,
      {
        'aviation:delays-bootstrap:v2': {
          alerts,
          coverage: coverage.map((hub) => (hub.iata === 'URC' ? { ...hub, status: 'failed' } : hub)),
        },
      },
      { 'seed-meta:aviation:intl': { fetchedAt: NOW, status: 'ok' } },
    );
    assert.equal(providerFailure.entries[0].status, 'degraded');
    assert.deepEqual(providerFailure.entries[0].content, {
      status: 'partial', ageMin: null, maxAgeMin: 120, required: 8, present: 7,
    });
    assert.ok(providerFailure.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CHINA_COVERAGE_PARTIAL));

    const providerOmission = evaluate(
      aviation,
      {
        'aviation:delays-bootstrap:v2': {
          alerts,
          coverage: coverage.map((hub) => (hub.iata === 'KMG' ? { ...hub, status: 'omitted' } : hub)),
        },
      },
      { 'seed-meta:aviation:intl': { fetchedAt: NOW, status: 'ok' } },
    );
    assert.equal(providerOmission.entries[0].status, 'degraded');
    assert.deepEqual(providerOmission.entries[0].content, {
      status: 'partial', ageMin: null, maxAgeMin: 120, required: 8, present: 7,
    });
    assert.ok(providerOmission.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CHINA_COVERAGE_PARTIAL));
  });

  it('uses Railway market transport plus the seeded CN index payload for China market coverage', () => {
    const market = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'market.china-index');
    const data = {
      'market:stock-index:v1:CN': {
        available: true,
        price: 3355,
        fetchedAt: NOW,
      },
    };

    const healthy = evaluate(market, data, { 'seed-meta:market:stocks': { fetchedAt: NOW, status: 'ok' } });
    assert.equal(healthy.entries[0].status, 'healthy');

    const staleTransport = evaluate(market, data, {
      'seed-meta:market:stocks': { fetchedAt: NOW - 1_441 * 60_000, status: 'ok' },
    });
    assert.equal(staleTransport.entries[0].status, 'degraded');
    assert.ok(staleTransport.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.TRANSPORT_STALE));

    const missingTransport = evaluate(market, data);
    assert.equal(missingTransport.entries[0].status, 'degraded');
    assert.ok(missingTransport.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.TRANSPORT_MISSING));
  });

  it('uses the source-specific China news projection rather than global top stories', () => {
    const news = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'news.china');
    const data = {
      'news:insights:v1:CN': {
        countryCode: 'CN',
        sources: ['Xinhua', 'MIIT (China)', 'MOFCOM (China)'].map((source) => ({
          source,
          status: 'available',
          observedAt: new Date(NOW).toISOString(),
        })),
      },
    };
    const healthy = evaluate(news, data, { 'seed-meta:news:insights': { fetchedAt: NOW, status: 'ok' } });
    assert.equal(healthy.entries[0].status, 'healthy');

    const sourceOutage = evaluate(news, {
      'news:insights:v1:CN': {
        countryCode: 'CN',
        sources: data['news:insights:v1:CN'].sources.map((row) => (
          row.source === 'MIIT (China)' ? { source: row.source, status: 'unavailable', reason: 'timeout' } : row
        )),
      },
    }, { 'seed-meta:news:insights': { fetchedAt: NOW, status: 'ok' } });
    assert.equal(sourceOutage.entries[0].status, 'degraded');
    assert.deepEqual(sourceOutage.entries[0].content, {
      status: 'partial', ageMin: null, maxAgeMin: 10_080, required: 3, present: 2,
    });
    assert.ok(sourceOutage.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CHINA_COVERAGE_PARTIAL));
  });

  it('fails read-only audits cleanly on missing credentials and partial pipelines', async () => {
    const priorUrl = process.env.UPSTASH_REDIS_REST_URL;
    const priorToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const priorFetch = globalThis.fetch;
    try {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      await assert.rejects(readChinaCoverageInputs([singleEntry()]), /Redis not configured/);

      process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      let requestInit;
      globalThis.fetch = async (_url, init) => {
        requestInit = init;
        return new Response(JSON.stringify([
          { result: null },
          { error: 'ERR injected' },
        ]), { status: 200 });
      };
      await assert.rejects(readChinaCoverageInputs([singleEntry()]), /1 command error/);
      assert.equal(new Headers(requestInit.headers).get('User-Agent'), 'worldmonitor-ops/1.0 (+https://worldmonitor.app)');

      globalThis.fetch = async () => new Response(JSON.stringify([
        { result: '{not-json' },
        { result: null },
      ]), { status: 200 });
      await assert.rejects(readChinaCoverageInputs([singleEntry()]), /malformed JSON/);
    } finally {
      globalThis.fetch = priorFetch;
      if (priorUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = priorUrl;
      if (priorToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = priorToken;
    }
  });
});

describe('China coverage evaluator', () => {
  it('separates fresh transport from missing China content', () => {
    const result = evaluate(
      singleEntry(),
      { 'data:test': { rows: [{ countryCode: 'US', observedAt: '2026-07-13T11:30:00Z' }] } },
      { 'seed-meta:test': { fetchedAt: NOW - 10 * 60_000, status: 'ok' } },
    );

    assert.equal(result.entries[0].transport.status, 'fresh');
    assert.equal(result.entries[0].content.status, 'missing');
    assert.equal(result.entries[0].status, 'degraded');
    assert.deepEqual(result.entries[0].reasonCodes, [CHINA_COVERAGE_REASON_CODES.CHINA_ROW_MISSING]);
    assert.equal(result.status, 'degraded');
  });

  it('classifies missing and empty fixtures without exposing raw payloads', () => {
    const missing = evaluate(singleEntry());
    assert.equal(missing.entries[0].status, 'unavailable');
    assert.deepEqual(missing.entries[0].reasonCodes, [
      CHINA_COVERAGE_REASON_CODES.TRANSPORT_MISSING,
      CHINA_COVERAGE_REASON_CODES.CHINA_ROW_MISSING,
    ]);

    const empty = evaluate(
      singleEntry(),
      { 'data:test': { rows: [{ countryCode: 'CN', observedAt: '2026-07-13T11:30:00Z', value: null }] } },
      { 'seed-meta:test': { fetchedAt: NOW - 10 * 60_000, status: 'ok' } },
    );
    assert.equal(empty.entries[0].content.status, 'empty');
    assert.ok(empty.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CHINA_ROW_EMPTY));
    assert.doesNotMatch(JSON.stringify(empty), /"rows"|"value"/);
  });

  it('does not let a fresh fetch hide stale source content', () => {
    const result = evaluate(
      singleEntry(),
      { 'data:test': { rows: [{ countryCode: 'CN', observedAt: '2026-07-12T00:00:00Z', value: 7 }] } },
      { 'seed-meta:test': { fetchedAt: NOW - 5 * 60_000, status: 'ok' } },
    );

    assert.equal(result.entries[0].transport.status, 'fresh');
    assert.equal(result.entries[0].content.status, 'stale');
    assert.ok(result.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CONTENT_STALE));
  });

  it('uses the IMF WEO forecast-year freshness convention for China macro', () => {
    const imfEntry = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'economic.imf-macro');
    const result = evaluate(
      imfEntry,
      { 'economic:imf:macro:v2': { countries: { CN: { latestYear: 2026, inflationPct: 1.2 } } } },
      { 'seed-meta:economic:imf-macro': { fetchedAt: NOW - 5 * 60_000, status: 'ok' } },
    );

    assert.equal(result.entries[0].transport.status, 'fresh');
    assert.equal(result.entries[0].content.status, 'fresh');
    assert.equal(result.entries[0].status, 'healthy');
  });

  it('treats future-dated transport and content timestamps as stale', () => {
    const result = evaluate(
      singleEntry(),
      { 'data:test': { rows: [{ countryCode: 'CN', observedAt: NOW + 5 * 60_000, value: 7 }] } },
      { 'seed-meta:test': { fetchedAt: NOW + 5 * 60_000, status: 'ok' } },
    );

    assert.equal(result.entries[0].transport.status, 'stale');
    assert.equal(result.entries[0].transport.ageMin, -5);
    assert.equal(result.entries[0].content.status, 'stale');
    assert.equal(result.entries[0].content.ageMin, -5);
    assert.ok(result.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.TRANSPORT_STALE));
    assert.ok(result.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CONTENT_STALE));
  });

  it('treats intermediate timestamp-path containers as substantive content', () => {
    const entry = singleEntry({
      content: {
        key: 'data:test',
        maxAgeMin: 400 * 1_440,
        probe: { kind: 'object', timestampPaths: [['sources', '*']] },
      },
    });
    const result = evaluate(
      entry,
      { 'data:test': { sources: { jodi: '2026-06', eia: '2026-05' } } },
      { 'seed-meta:test': { fetchedAt: NOW - 5 * 60_000, status: 'ok' } },
    );

    assert.equal(result.entries[0].content.status, 'fresh');
    assert.equal(result.entries[0].status, 'healthy');
  });

  it('reports partial required coverage with the missing member count', () => {
    const entry = singleEntry({
      content: {
        key: 'data:test',
        maxAgeMin: 180,
        probe: {
          kind: 'array-coverage',
          path: ['rows'],
          field: 'iata',
          values: ['PEK', 'PVG', 'CAN'],
          timestampPaths: [['updatedAt']],
        },
      },
    });
    const result = evaluate(
      entry,
      { 'data:test': { rows: [
        { iata: 'PEK', updatedAt: NOW - 5 * 60_000, value: 1 },
        { iata: 'PVG', updatedAt: NOW - 5 * 60_000, value: 1 },
      ] } },
      { 'seed-meta:test': { fetchedAt: NOW - 5 * 60_000, status: 'ok' } },
    );

    assert.equal(result.entries[0].content.status, 'partial');
    assert.equal(result.entries[0].content.required, 3);
    assert.equal(result.entries[0].content.present, 2);
    assert.ok(result.entries[0].reasonCodes.includes(CHINA_COVERAGE_REASON_CODES.CHINA_COVERAGE_PARTIAL));
  });

  it('keeps planned entries explicit without degrading launched coverage', () => {
    const planned = singleEntry({ id: 'macro.china-snapshot', launchStatus: 'planned' });
    const result = evaluate(planned);
    assert.equal(result.status, 'healthy');
    assert.equal(result.entries[0].status, 'planned');
    assert.deepEqual(result.entries[0].reasonCodes, [CHINA_COVERAGE_REASON_CODES.NOT_LAUNCHED]);
  });

  it('reports a stable reason when a China contract is blocked', () => {
    const blocked = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'energy.jodi-oil');
    const result = evaluate(blocked);

    assert.equal(result.entries[0].status, 'blocked');
    assert.deepEqual(result.entries[0].reasonCodes, [
      CHINA_COVERAGE_REASON_CODES.NOT_LAUNCHED,
      CHINA_COVERAGE_REASON_CODES.CHINA_UPSTREAM_ROW_UNAVAILABLE,
    ]);
  });

  it('renders a bounded human-readable audit without raw upstream data', () => {
    const result = evaluate(
      singleEntry(),
      { 'data:test': { rows: [{ countryCode: 'CN', observedAt: '2026-07-13T11:30:00Z', value: 42 }] } },
      { 'seed-meta:test': { fetchedAt: NOW - 10 * 60_000, status: 'ok' } },
    );
    const output = formatChinaCoverageHuman(result);
    assert.match(output, /China coverage: HEALTHY/);
    assert.match(output, /test\.china-row/);
    assert.doesNotMatch(output, /42|"rows"/);
  });
});
