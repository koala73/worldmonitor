import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDelaysBootstrapPayload,
  CHINA_AVIATIONSTACK_HUBS,
  fetchIntl,
  publishTransform,
  runChinaAviationStackSmoke,
  seedIntlDelays,
  validate,
} from '../scripts/seed-aviation.mjs';
import { CHINA_COVERAGE_ENTRIES } from '../scripts/china-coverage-manifest.mjs';
import { evaluateChinaCoverage } from '../scripts/china-coverage-health.mjs';

const AGREED_HUBS = ['PEK', 'PVG', 'CAN', 'SZX', 'CTU', 'KMG', 'URC', 'HKG'];
const airportConfig = readFileSync(fileURLToPath(new URL('../src/config/airports.ts', import.meta.url)), 'utf8');

function flight({ status = 'scheduled', delay = 0 } = {}) {
  return {
    flight_status: status,
    departure: { delay },
  };
}

describe('China hub recovery before international publication', () => {
  const envNames = ['AVIATIONSTACK_API', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'AVIATIONSTACK_MONTHLY_BUDGET'];
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  afterEach(() => {
    mock.restoreAll();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function fixture({ failures = ['MEX', 'FRA', 'LIS', 'KMG', 'SIN', 'AUH'], recover = true, cap = 100, omitted = false } = {}) {
    process.env.AVIATIONSTACK_API = 'synthetic-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = String(cap);
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    const calls = new Map();
    const initialAt = Date.parse('2026-09-10T07:30:00Z');
    let now = initialAt;
    let counter = 56; // main has already reserved the initial sweep.
    mock.method(Date, 'now', () => now);
    mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).endsWith('/pipeline')) {
        return { ok: true, json: async () => JSON.parse(options.body).map(([verb, , count]) => {
          if (verb === 'INCRBY') counter += count;
          if (verb === 'DECRBY') counter -= count;
          return { result: counter };
        }) };
      }
      const iata = new URL(url).searchParams.get('dep_iata');
      assert.ok(iata, `unexpected request: ${url}`);
      const attempt = (calls.get(iata) ?? 0) + 1;
      calls.set(iata, attempt);
      if (attempt > 1) now = initialAt + 30_000;
      if (failures.includes(iata) && (attempt === 1 || !recover)) {
        if (omitted) return { ok: true, json: async () => ({ data: [] }) };
        throw new Error('synthetic timeout');
      }
      return { ok: true, json: async () => ({ data: [flight({ delay: ['KMG', 'CAN'].includes(iata) ? 65 : 0 })] }) };
    });
    return { calls, initialAt, counter: () => counter };
  }

  function health(data, now) {
    const entry = CHINA_COVERAGE_ENTRIES.find(({ id }) => id === 'aviation.china-hubs');
    const bootstrap = buildDelaysBootstrapPayload({ faaPayload: null, intlPayload: publishTransform(data), notamPayload: null });
    return evaluateChinaCoverage({
      entries: [entry], now,
      data: { [entry.content.key]: bootstrap },
      meta: { [entry.transport.key]: { fetchedAt: now, status: 'ok' } },
    }).entries[0];
  }

  it('retries only KMG after the reported six timeouts and carries recovery through bootstrap to health', async () => {
    const state = fixture();
    const result = await fetchIntl();
    assert.equal(state.calls.size, 56);
    assert.deepEqual([...state.calls].filter(([, count]) => count > 1), [['KMG', 2]]);
    assert.equal(state.counter(), 57);
    assert.equal(result.coverage.find(({ iata }) => iata === 'KMG').status, 'disruption');
    assert.equal(result.alerts.filter(({ iata }) => iata === 'KMG').length, 1);
    assert.equal(result.alerts.find(({ iata }) => iata === 'CAN').updatedAt, state.initialAt);
    assert.ok(result.coverage.filter(({ iata }) => iata !== 'KMG').every(({ updatedAt }) => updatedAt === state.initialAt));
    assert.equal(result.coverage.find(({ iata }) => iata === 'KMG').updatedAt, state.initialAt + 30_000);
    assert.equal(health(result, state.initialAt + 30_000).status, 'healthy');
  });

  it('keeps repeated failure partial without another retry or invented coverage', async () => {
    const state = fixture({ recover: false });
    const result = await fetchIntl();
    assert.equal(state.calls.get('KMG'), 2);
    assert.equal(state.counter(), 57);
    assert.equal(result.healthy, true);
    assert.equal(health(result, state.initialAt + 30_000).content.status, 'partial');
    assert.equal(result.coverage.find(({ iata }) => iata === 'KMG').updatedAt, state.initialAt);
  });

  it('does not retry when the shared budget denies the extra call', async () => {
    const state = fixture({ cap: 56 });
    const result = await fetchIntl();
    assert.equal(state.calls.get('KMG'), 1);
    assert.equal(state.counter(), 56);
    assert.equal(health(result, state.initialAt).content.status, 'partial');
  });

  it('retries provider omission once and recovers all eight hubs within eight extra calls', async () => {
    const state = fixture({ failures: AGREED_HUBS, omitted: true });
    const result = await fetchIntl();
    assert.equal(state.counter(), 64);
    assert.ok(AGREED_HUBS.every((iata) => state.calls.get(iata) === 2));
    assert.equal(health(result, state.initialAt + 30_000).status, 'healthy');
  });

  it('keeps systemic failure nonRetryable so runSeed retains last-good data', async () => {
    const state = fixture();
    mock.method(globalThis, 'fetch', async () => { throw new Error('provider down'); });
    await assert.rejects(fetchIntl(), { nonRetryable: true });
    assert.equal(state.counter(), 56);
  });

  it('does not spend extra calls when all required hubs are covered', async () => {
    const state = fixture({ failures: ['MEX'] });
    await fetchIntl();
    assert.equal(state.counter(), 56);
    assert.ok([...state.calls.values()].every((count) => count === 1));
  });
});

describe('China AviationStack hub contract', () => {
  it('covers the agreed provider-backed hub set with exact IATA and ICAO metadata', () => {
    assert.deepEqual(CHINA_AVIATIONSTACK_HUBS.map((hub) => hub.iata), AGREED_HUBS);
    assert.deepEqual(CHINA_AVIATIONSTACK_HUBS.map((hub) => hub.icao), [
      'ZBAA', 'ZSPD', 'ZGGG', 'ZGSZ', 'ZUUU', 'ZPPP', 'ZWWW', 'VHHH',
    ]);
    for (const hub of CHINA_AVIATIONSTACK_HUBS) {
      assert.ok(hub.sources.includes('aviationstack'), `${hub.iata} must be provider-backed`);
      assert.equal(hub.country, 'China');
      assert.equal(typeof hub.lat, 'number');
      assert.equal(typeof hub.lon, 'number');
      const occurrences = airportConfig.match(new RegExp(`'${hub.iata}'`, 'g'))?.length ?? 0;
      assert.ok(occurrences >= 2, `${hub.iata} must be in monitored and AviationStack client registries`);
    }
  });

  it('distinguishes normal operations, provider omission, disruption, and one-hub failure', async () => {
    const fetchFn = async (url) => {
      const iata = new URL(url).searchParams.get('dep_iata');
      if (iata === 'URC') throw new Error('simulated timeout');
      if (iata === 'KMG') return { ok: true, json: async () => ({ data: [] }) };
      if (iata === 'CAN') {
        return { ok: true, json: async () => ({ data: [flight({ delay: 65 })] }) };
      }
      return { ok: true, json: async () => ({ data: [flight()] }) };
    };

    const result = await seedIntlDelays({
      apiKey: 'test-secret',
      airports: CHINA_AVIATIONSTACK_HUBS,
      fetchFn,
      logger: { log() {}, warn() {} },
    });

    assert.equal(result.healthy, true, 'one provider failure must not blank healthy hubs');
    assert.deepEqual(
      Object.fromEntries(result.coverage.map((hub) => [hub.iata, hub.status])),
      {
        PEK: 'normal',
        PVG: 'normal',
        CAN: 'disruption',
        SZX: 'normal',
        CTU: 'normal',
        KMG: 'omitted',
        URC: 'failed',
        HKG: 'normal',
      },
    );
    assert.deepEqual(result.alerts.map((alert) => alert.iata), ['CAN']);

    const published = publishTransform(result);
    assert.deepEqual(published.alerts.map((alert) => alert.iata), ['CAN']);
    assert.deepEqual(published.coverage, result.coverage);
    assert.ok(published.coverage.every((hub) => Number.isFinite(hub.updatedAt)), 'coverage rows retain their observation timestamp');
    assert.equal(validate(published), true);
    assert.equal(validate({ alerts: published.alerts }), false, 'coverage is part of the canonical contract');
    assert.equal(validate({ alerts: [], coverage: [{ iata: 'PEK', status: 'unknown', flightCount: 0 }] }), false);
    assert.equal(validate({ alerts: [], coverage: [{ iata: 'PEK', status: 'normal', flightCount: 0 }] }), false, 'coverage timestamps are required');

    const bootstrap = buildDelaysBootstrapPayload({
      faaPayload: null,
      intlPayload: published,
      notamPayload: null,
      fillerRegistry: CHINA_AVIATIONSTACK_HUBS,
    });
    assert.equal(bootstrap.alerts.find((alert) => alert.iata === 'CAN')?.severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
    for (const iata of ['KMG', 'URC']) {
      const unavailable = bootstrap.alerts.find((alert) => alert.iata === iata);
      assert.equal(unavailable?.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
      assert.equal(unavailable?.source, 'FLIGHT_DELAY_SOURCE_UNSPECIFIED');
    }
    for (const iata of ['PEK', 'PVG', 'SZX', 'CTU', 'HKG']) {
      const covered = bootstrap.alerts.find((alert) => alert.iata === iata);
      assert.equal(covered?.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
      assert.equal(covered?.source, 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK');
    }

    const legacyBootstrap = buildDelaysBootstrapPayload({
      faaPayload: null,
      intlPayload: { alerts: [] },
      notamPayload: null,
      fillerRegistry: CHINA_AVIATIONSTACK_HUBS,
    });
    for (const alert of legacyBootstrap.alerts) {
      assert.equal(alert.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
      assert.equal(alert.source, 'FLIGHT_DELAY_SOURCE_UNSPECIFIED');
    }
  });

  it('prints Railway-safe smoke evidence for every hub without exposing the credential', async () => {
    const lines = [];
    const fetchFn = async () => ({ ok: true, json: async () => ({ data: [flight()] }) });

    const result = await runChinaAviationStackSmoke({
      apiKey: 'railway-secret-value',
      fetchFn,
      logger: { log: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) },
    });

    assert.equal(result.ok, true);
    const output = lines.join('\n');
    for (const iata of AGREED_HUBS) assert.match(output, new RegExp(`\\b${iata}=normal\\b`));
    assert.doesNotMatch(output, /railway-secret-value/);
    assert.doesNotMatch(output, /access_key=/);
  });
});
