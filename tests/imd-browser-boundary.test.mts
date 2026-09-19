import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { assembleImdSnapshot, parseImdProductPayload } from '../scripts/lib/imd-cyclone-marine.mjs';

let source: string;
let app: typeof import('../src/services/imd-cyclone-marine') & { bootstrap: typeof import('../src/services/bootstrap').__testing__ };
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = Date.parse('2026-09-15T12:00:00Z');
const event = { id: 'imd-test', title: 'Storm', category: 'severeStorms', categoryTitle: 'Cyclone', lat: 15, lon: 80, date: now, closed: false };
const alert = { id: 'port-test', event: 'IMD Port Warning', severity: 'Severe', headline: 'Port warning', description: 'Warning', areaDesc: 'Port', onset: now, expires: now + 3600000, coordinates: [[80, 15]], source: 'IMD' };
const snapshot = () => ({ generatedAt: now, coverageState: 'ok', cycloneEvents: [event], portAlerts: [alert], marineBulletins: [], sourceName: 'IMD', sourceUrl: 'https://rsmcnewdelhi.imd.gov.in' });
before(async () => {
  const result = await build({ stdin: { contents: "export * from './src/services/imd-cyclone-marine.ts'; export { __testing__ as bootstrap } from './src/services/bootstrap.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', define: { 'import.meta.env': '{"DEV":false}' } });
  source = result.outputFiles[0].text;
});
beforeEach(async () => {
  app = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`);
  now = Date.parse('2026-09-15T12:00:00Z');
  Date.now = () => now;
});
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });

test('both consumers share accepted hydration even when refetch would fail; expiry retries and recovers', async () => {
  app.bootstrap.seedHydrationCacheForTests({ imdCycloneMarine: snapshot() });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  const results = await Promise.all([app.fetchImdCycloneMarine(), app.fetchImdCycloneMarine()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[1].cycloneEvents.length, 1);
  assert.equal(calls, 0);
  now += 61_000;
  assert.equal((await app.fetchImdCycloneMarine()).coverageState, 'unavailable');
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; return Response.json({ data: { imdCycloneMarine: snapshot() } }); };
  assert.equal((await app.fetchImdCycloneMarine()).coverageState, 'ok');
  assert.equal(calls, 2);
});

test('cold consumers coalesce through the real public bootstrap and valid empty is retained', async () => {
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    assert.match(String(input), /keys=imdCycloneMarine&public=1/);
    return Response.json({ data: { imdCycloneMarine: { ...snapshot(), cycloneEvents: [], portAlerts: [] } } });
  };
  const [a, b] = await Promise.all([app.fetchImdCycloneMarine(), app.fetchImdCycloneMarine()]);
  assert.equal(a.coverageState, 'ok'); assert.deepEqual(a, b);
  assert.equal((await app.fetchImdCycloneMarine()).coverageState, 'ok');
  assert.equal(calls, 1);
});

test('malformed collections and invalid records never become healthy empty data', () => {
  for (const value of [null, [], {}, { ...snapshot(), cycloneEvents: {} }, { ...snapshot(), portAlerts: 'bad' }]) {
    assert.notEqual(app.mapImdSnapshot(value as never).coverageState, 'ok');
  }
  for (const invalid of [null, {}, { ...event, lat: 91 }, { ...event, lon: NaN }, { ...event, date: 'bad' }]) {
    assert.equal(app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [invalid] } as never).cycloneEvents.length, 0);
  }
  for (const invalid of [{ ...alert, onset: 'bad' }, { ...alert, coordinates: [[181, 0]] }, { ...alert, expires: 9e99 }]) {
    assert.equal(app.mapImdSnapshot({ ...snapshot(), portAlerts: [invalid] } as never).portAlerts.length, 0);
  }
});

test('allowed fields survive; raw properties and nonnumeric storm fields are removed', () => {
  const result = app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [{ ...event, windKt: '<img>', pressureMb: Infinity, extra: 'untrusted', forecastTrack: [null, { lat: 15, lon: 80, hour: 12, windKt: 45, category: 0, extra: true }] }], portAlerts: [{ ...alert, wind: '20 kt', extra: true }] } as never);
  const storm = result.cycloneEvents[0];
  assert.equal(storm.windKt, undefined); assert.equal(storm.pressureMb, undefined);
  assert.equal('extra' in storm, false);
  assert.deepEqual(storm.forecastTrack, [{ lat: 15, lon: 80, hour: 12, windKt: 45, category: 0 }]);
  assert.equal(result.portAlerts[0].wind, '20 kt'); assert.equal('extra' in result.portAlerts[0], false);
  assert.equal(result.sourceName, 'IMD');
});

test('real producer fixtures preserve cyclone tracks, cone, wind radii, marine fields and attribution', () => {
  const products = Object.fromEntries([
    ['cycloneTrack', 'imd-cyclone-track.json'], ['cycloneCou', 'imd-cyclone-cou.json'],
    ['cycloneWind', 'imd-cyclone-wind.json'], ['portWarning', 'imd-port-warning.json'],
    ['seaBulletin', 'imd-sea-bulletin.json'], ['coastalBulletin', 'imd-coastal-bulletin.json'],
  ].map(([key, file]) => [key, { status: 'ok', records: parseImdProductPayload(key, JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'))) }]));
  const raw = assembleImdSnapshot({ productResults: products, now });
  const mapped = app.mapImdSnapshot(raw);
  assert.equal(mapped.coverageState, raw.coverageState);
  for (const key of ['cycloneEvents', 'portAlerts', 'marineBulletins'] as const) {
    assert.equal(mapped[key].length, raw[key].length);
    for (let i = 0; i < raw[key].length; i++) {
      for (const [field, value] of Object.entries(raw[key][i])) {
        if (value === undefined || field === 'isForecastBulletin') continue;
        const actual = (mapped[key][i] as unknown as Record<string, unknown>)[field];
        assert.deepEqual(actual instanceof Date ? actual.getTime() : actual, value, `${key}.${field}`);
      }
    }
  }
  assert.equal(mapped.sourceName, raw.sourceName); assert.equal(mapped.sourceUrl, raw.sourceUrl);
});


test('unavailable or disabled snapshots do not become available because some records are valid', async () => {
  for (const coverageState of ['unavailable', 'disabled']) {
    const raw = { ...snapshot(), coverageState, marineBulletins: null };
    assert.equal(app.mapImdSnapshot(raw).coverageState, coverageState);
  }
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ data: { imdCycloneMarine: { ...snapshot(), coverageState: 'unavailable' } } }); };
  await app.fetchImdCycloneMarine();
  await app.fetchImdCycloneMarine();
  assert.equal(calls, 2);
});


test('blank identity/display fields are rejected while empty bulletin details remain valid', () => {
  for (const key of ['id', 'title']) {
    assert.equal(app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [{ ...event, [key]: '  ' }] }).cycloneEvents.length, 0);
  }
  for (const key of ['id', 'event', 'headline']) {
    assert.equal(app.mapImdSnapshot({ ...snapshot(), portAlerts: [{ ...alert, [key]: '' }] }).portAlerts.length, 0);
  }
  assert.equal(app.mapImdSnapshot({ ...snapshot(), portAlerts: [{ ...alert, description: '', areaDesc: '' }] }).portAlerts.length, 1);
});
