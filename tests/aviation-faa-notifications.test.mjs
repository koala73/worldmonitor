// FAA ground stops and closures must reach the notification queue. On the
// 2026-11-13 national ground stop the seeder published FAA alerts every tick
// but only AviationStack alerts were ever dispatched, so no US airport alert
// was queued during the stop. These tests run the real seeder against a fixture
// Redis and a fixture FAA airport status feed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

const groundStop = arpt => `<Ground_Stop><ARPT>${arpt}</ARPT><Reason>equipment / outage</Reason><End_Time>9:45 pm EST</End_Time></Ground_Stop>`;
const closure = (arpt, reason) => `<Airport><ARPT>${arpt}</ARPT><Reason>${reason}</Reason><Start>Nov 14 at 00:04 UTC.</Start><Reopen>Nov 14 at 11:00 UTC.</Reopen></Airport>`;
const faaXml = ({ stops = [], closures = [] }) => '<AIRPORT_STATUS_INFORMATION><Update_Time>Fri Nov 13 21:03:00 2026 GMT</Update_Time>'
  + `<Delay_type><Name>Ground Stops</Name><Ground_Stop_List>${stops.map(groundStop).join('')}</Ground_Stop_List></Delay_type>`
  + `<Delay_type><Name>Airport Closures</Name><Airport_Closure_List>${closures.map(([a, r]) => closure(a, r)).join('')}</Airport_Closure_List></Delay_type>`
  + '</AIRPORT_STATUS_INFORMATION>';

const preload = `
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.TEST_STATE_PATH;
const values = new Map(JSON.parse(readFileSync(statePath, 'utf8')));
if (process.env.TEST_EXPIRE_DEDUP === '1') {
  for (const key of [...values.keys()]) if (key.startsWith('wm:notif:scan-dedup:')) values.delete(key);
}
const pushes = [];
const command = ([verb, key, value, ...args]) => {
  if (verb === 'GET') return values.get(key) ?? null;
  if (verb === 'EXISTS') return values.has(key) ? 1 : 0;
  if (verb === 'SET') {
    if (args.includes('NX') && values.has(key)) return null;
    values.set(key, value);
    return 'OK';
  }
  if (verb === 'EXPIRE') return values.has(key) ? 1 : 0;
  if (verb === 'EVAL') { values.delete(args[0]); return 1; }
  if (verb === 'LPUSH') {
    if (process.env.TEST_LPUSH_FAIL === '1') return 0;
    pushes.push(JSON.parse(value));
    return 1;
  }
  if (verb === 'DEL') {
    if (process.env.TEST_DEL_FAIL === '1') return 0;
    values.delete(key);
    return 1;
  }
  throw new Error('Unexpected Redis command ' + verb);
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'seed-test.invalid') {
    if (url.pathname.startsWith('/get/')) {
      return Response.json({ result: values.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
    }
    const body = JSON.parse(options.body);
    if (url.pathname === '/pipeline') return Response.json(body.map(item => ({ result: command(item) })));
    return Response.json({ result: command(body) });
  }
  if (url.hostname === 'nasstatus.faa.gov') {
    return new Response(process.env.TEST_FAA_XML, { headers: { 'content-type': 'application/xml' } });
  }
  throw new Error('fixture source unavailable');
};
process.on('exit', () => {
  writeFileSync(statePath, JSON.stringify([...values]));
  console.log('FIXTURE_PUSHES=' + JSON.stringify(pushes));
  console.log('FIXTURE_FAA=' + (values.get('aviation:delays:faa:v1') ?? 'null'));
});
`;

function makeRunner() {
  const directory = mkdtempSync(join(tmpdir(), 'aviation-faa-notify-'));
  const preloadPath = join(directory, 'preload.mjs');
  const statePath = join(directory, 'redis.json');
  const envFile = join(directory, 'empty.env');
  writeFileSync(preloadPath, preload);
  writeFileSync(statePath, '[]');
  writeFileSync(envFile, '');
  const run = (feed, extraEnv = {}) => {
    const result = spawnSync(process.execPath, ['--import', preloadPath, 'seed-aviation.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        ICAO_API_KEY: '',
        AVIATIONSTACK_API: '',
        AVIATIONSTACK_MONTHLY_BUDGET: '0',
        AVIATIONSTACK_MIN_REFRESH_MIN: '0',
        WM_SEED_RETRY_DELAY_MS: '0',
        WM_SEED_ENV_FILE: envFile,
        TEST_STATE_PATH: statePath,
        TEST_FAA_XML: faaXml(feed),
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    // No AVIATIONSTACK_API key, so the intl stage ends with its documented exit 75.
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.match(result.stdout, /\[FAA\] wrote \d+ alerts/);
    const read = (prefix) => {
      const line = result.stdout.split('\n').find(l => l.startsWith(prefix));
      assert.ok(line, result.stdout + result.stderr);
      return JSON.parse(line.slice(prefix.length));
    };
    const pushes = read('FIXTURE_PUSHES=');
    const faa = read('FIXTURE_FAA=');
    return Object.assign(pushes, { faaAlerts: (faa?.data ?? faa)?.alerts ?? [] });
  };
  return { run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const closureTitles = pushes => pushes
  .filter(p => p.eventType === 'aviation_closure')
  .map(p => p.payload.title)
  .sort();

test('an FAA ground stop and a full closure each queue an aviation_closure notification', () => {
  const { run, cleanup } = makeRunner();
  try {
    const pushes = run({ stops: ['JFK'], closures: [['MCO', '!MCO 11/001 MCO AD AP CLSD 2611132100-2611140300']] });
    const titles = closureTitles(pushes);
    assert.equal(titles.length, 2, JSON.stringify(pushes));
    assert.match(titles.find(t => t.startsWith('JFK')) ?? '', /ground stop/i);
    assert.match(titles.find(t => t.startsWith('MCO')) ?? '', /closure/i);
    const jfk = pushes.find(p => p.payload.title.startsWith('JFK'));
    assert.equal(jfk.payload.source, 'FAA');
    // notification-relay delivers only critical events to realtime rules.
    assert.equal(jfk.severity, 'critical', 'a ground stop must be deliverable');
    assert.equal(jfk.payload.countryCode, 'US');
    assert.equal(typeof jfk.payload.lat, 'number');
  } finally {
    cleanup();
  }
});

test('an unchanged FAA state on the next tick queues nothing new', () => {
  const { run, cleanup } = makeRunner();
  try {
    const feed = { stops: ['JFK'] };
    assert.equal(closureTitles(run(feed)).length, 1);
    assert.deepEqual(closureTitles(run(feed)), []);
    assert.equal(closureTitles(run({ stops: ['JFK', 'ORD'] })).length, 1, 'a newly stopped airport still notifies');
  } finally {
    cleanup();
  }
});

test('an airport closed only to diverted aircraft is not reported or notified as closed', () => {
  // Reason text copied from the live FAA feed on 2026-11-14, after the ground stop.
  const { run, cleanup } = makeRunner();
  try {
    const pushes = run({ closures: [
      ['DCA', '!DCA 11/261 DCA AD AP CLSD TO DIVERSION ACFT 2611140004-2611141100'],
      ['FLL', '!FLL 11/142 FLL AD AP CLSD TO DIVERSION ACFT DUE TO CAPACITY 2611140038-2611140900'],
    ] });
    assert.deepEqual(pushes.faaAlerts.map(a => a.iata), [], 'the dashboard must not show these airports as closed');
    assert.deepEqual(closureTitles(pushes), []);
  } finally {
    cleanup();
  }
});

test('a ground stop whose queue push failed is retried on the next tick', () => {
  const { run, cleanup } = makeRunner();
  try {
    const feed = { stops: ['JFK'] };
    assert.deepEqual(closureTitles(run(feed, { TEST_LPUSH_FAIL: '1' })), []);
    assert.equal(closureTitles(run(feed)).length, 1, 'the failed notification is not recorded as sent');
  } finally {
    cleanup();
  }
});

test('a dedup key left by a failed push and a failed rollback does not mark the airport as sent', () => {
  const { run, cleanup } = makeRunner();
  try {
    const feed = { stops: ['JFK'] };
    assert.deepEqual(closureTitles(run(feed, { TEST_LPUSH_FAIL: '1', TEST_DEL_FAIL: '1' })), []);
    assert.deepEqual(closureTitles(run(feed)), [], 'the stale dedup key still blocks the push');
    assert.equal(closureTitles(run(feed, { TEST_EXPIRE_DEDUP: '1' })).length, 1, 'publishes once the dedup key expires');
  } finally {
    cleanup();
  }
});
