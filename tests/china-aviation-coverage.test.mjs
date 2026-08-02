import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDelaysBootstrapPayload,
  CHINA_AVIATIONSTACK_HUBS,
  publishTransform,
  runChinaAviationStackSmoke,
  seedIntlDelays,
  validate,
} from '../scripts/seed-aviation.mjs';

const AGREED_HUBS = ['PEK', 'PVG', 'CAN', 'SZX', 'CTU', 'KMG', 'URC', 'HKG'];
const airportConfig = readFileSync(fileURLToPath(new URL('../src/config/airports.ts', import.meta.url)), 'utf8');

function flight({ status = 'scheduled', delay = 0 } = {}) {
  return {
    flight_status: status,
    departure: { delay },
  };
}

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
