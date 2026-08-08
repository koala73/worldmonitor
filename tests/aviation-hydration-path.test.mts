import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

type Harness = {
  fetchBootstrapData: () => Promise<void>;
  fetchFlightDelays: () => Promise<Array<{ iata: string; severity: string; source: string }>>;
  bootstrapTesting: { resetBootstrapForTests: () => void };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalFetch = globalThis.fetch;
let harness: Harness;

before(async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { fetchFlightDelays } from './src/services/aviation/index.ts';",
        "export { fetchBootstrapData, __testing__ as bootstrapTesting } from './src/services/bootstrap.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'aviation-hydration-test-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the hydration harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Harness;
});

afterEach(() => {
  harness.bootstrapTesting.resetBootstrapForTests();
  globalThis.fetch = originalFetch;
});

describe('aviation bootstrap hydration path', () => {
  it('preserves UNKNOWN China hubs on first paint without falling through to the RPC', async () => {
    const requests: string[] = [];
    const alerts = [
      {
        id: 'unknown-KMG', iata: 'KMG', icao: 'ZPPP', name: 'Kunming Changshui', city: 'Kunming', country: 'China',
        location: { latitude: 25.1019, longitude: 102.9292 }, region: 'AIRPORT_REGION_APAC',
        delayType: 'FLIGHT_DELAY_TYPE_GENERAL', severity: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
        avgDelayMinutes: 0, delayedFlightsPct: 0, cancelledFlights: 0, totalFlights: 0,
        reason: 'Coverage unavailable', source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED', updatedAt: Date.now(),
      },
      {
        id: 'unknown-URC', iata: 'URC', icao: 'ZWWW', name: 'Urumqi Diwopu', city: 'Urumqi', country: 'China',
        location: { latitude: 43.9071, longitude: 87.4742 }, region: 'AIRPORT_REGION_APAC',
        delayType: 'FLIGHT_DELAY_TYPE_GENERAL', severity: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
        avgDelayMinutes: 0, delayedFlightsPct: 0, cancelledFlights: 0, totalFlights: 0,
        reason: 'Coverage unavailable', source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED', updatedAt: Date.now(),
      },
      {
        id: 'status-PEK', iata: 'PEK', icao: 'ZBAA', name: 'Beijing Capital', city: 'Beijing', country: 'China',
        location: { latitude: 40.0799, longitude: 116.6031 }, region: 'AIRPORT_REGION_APAC',
        delayType: 'FLIGHT_DELAY_TYPE_GENERAL', severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
        avgDelayMinutes: 0, delayedFlightsPct: 0, cancelledFlights: 0, totalFlights: 0,
        reason: 'Normal operations', source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK', updatedAt: Date.now(),
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (!url.includes('/api/bootstrap?')) throw new Error(`unexpected RPC request: ${url}`);
      return new Response(JSON.stringify({ data: { flightDelays: { alerts } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await harness.fetchBootstrapData();
    const result = await harness.fetchFlightDelays();

    assert.deepEqual(
      Object.fromEntries(result.map((alert) => [alert.iata, { severity: alert.severity, source: alert.source }])),
      {
        KMG: { severity: 'unknown', source: 'unspecified' },
        URC: { severity: 'unknown', source: 'unspecified' },
        PEK: { severity: 'normal', source: 'aviationstack' },
      },
    );
    assert.equal(requests.filter((url) => !url.includes('/api/bootstrap?')).length, 0,
      'hydrated delays must short-circuit before the RPC client');
  });
});
