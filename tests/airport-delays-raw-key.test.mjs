import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// redis.ts memoizes the deployment prefix, so each environment needs a fresh process.
const fixture = `
import assert from 'node:assert/strict';
import { seedIntlDelays, publishTransform } from './scripts/seed-aviation.mjs';
import { buildEnvelope } from './scripts/_seed-envelope-source.mjs';
import { listAirportDelays } from './server/worldmonitor/aviation/v1/list-airport-delays.ts';

const intlKey = 'aviation:delays:intl:v3';
const produced = await seedIntlDelays({
  apiKey: 'fixture-only',
  airports: ['LHR', 'FRA', 'CDG'].map(iata => ({ iata })),
  logger: { log() {}, warn() {} },
  fetchFn: async url => {
    const iata = new URL(url).searchParams.get('dep_iata');
    return Response.json({ data: iata === 'CDG' ? [] : [{ flight_status: 'scheduled', departure: { delay: iata === 'FRA' ? 90 : 0 } }] });
  },
});
assert.deepEqual(produced.coverage.map(hub => hub.status), ['normal', 'disruption', 'omitted']);
const envelope = buildEnvelope({ fetchedAt: Date.now(), recordCount: produced.alerts.length, sourceVersion: 'fixture', schemaVersion: 1, state: 'OK', data: publishTransform(produced) });
const reads = [];
const origins = new Set();
const writes = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  origins.add(url.origin);
  assert.equal(url.origin, 'https://redis.test');
  if (url.pathname.startsWith('/get/')) {
    const key = decodeURIComponent(url.pathname.slice(5));
    reads.push(key);
    const value = key === intlKey ? envelope : key === 'aviation:delays:faa:v1' ? { alerts: [] } : null;
    return Response.json({ result: value === null ? null : JSON.stringify(value) });
  }
  // Finding 5 removes the independent bootstrap write. Accept it here so this
  // regression is valid before and after that separate repair.
  const command = JSON.parse(String(init.body));
  writes.push(command);
  return Response.json({ result: 'OK' });
};
const response = await listAirportDelays({}, {});
assert.ok(reads.includes(intlKey), 'must read the bare key written by the seeder; saw ' + reads.join(', '));
assert.ok(reads.includes('aviation:delays:faa:v1'));
assert.ok(reads.every(key => !key.startsWith('preview:') && !key.startsWith('development:')));
const alert = iata => response.alerts.find(row => row.iata === iata);
assert.equal(alert('LHR').severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
assert.equal(alert('LHR').source, 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK');
assert.equal(alert('FRA').severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
assert.equal(alert('FRA').avgDelayMinutes, 90);
assert.equal(alert('CDG').severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
assert.equal(alert('JFK').severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
assert.deepEqual([...origins], ['https://redis.test']);
assert.ok(writes.every(command => command[0] === 'SET' && command[1].endsWith('aviation:delays-bootstrap:v2')));
`;

for (const environment of ['preview', 'development', 'production', '']) {
  test(`airport delays read producer data with VERCEL_ENV=${environment || '(empty)'}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env, VERCEL_ENV: environment, VERCEL_GIT_COMMIT_SHA: '0123456789abcdef',
        UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        LOCAL_API_MODE: '', ICAO_API_KEY: '', SEED_FALLBACK_NOTAM: '',
      },
      timeout: 15_000,
      stdio: 'pipe',
    }));
  });
}
