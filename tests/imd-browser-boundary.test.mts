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

test('the hydration handoff shares one accepted snapshot for 60s, then retries and recovers', async () => {
  // Both map layers (natural + weather) call fetchImdCycloneMarine() in the
  // same tick; getHydratedData() is consume-once, so the second read must come
  // from createHydrationHandoff (#8386), not a failed refetch.
  app.bootstrap.seedHydrationCacheForTests({ imdCycloneMarine: snapshot() });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  const [natural, weather] = await Promise.all([app.fetchImdCycloneMarine(), app.fetchImdCycloneMarine()]);
  assert.equal(weather, natural, 'both layers receive the same accepted object');
  assert.equal(natural.coverageState, 'ok');
  assert.equal(natural.cycloneEvents.length, 1);
  assert.equal(natural.portAlerts.length, 1);
  assert.equal(calls, 0);

  now += 60_000;
  assert.equal(await app.fetchImdCycloneMarine(), natural, 'still inside the 60s handoff window');
  assert.equal(calls, 0);

  now += 1;
  assert.equal((await app.fetchImdCycloneMarine()).coverageState, 'unavailable', 'expired handoff goes back to the load path');
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

test('malformed collections never report healthy coverage', () => {
  for (const value of [null, [], {}, { ...snapshot(), cycloneEvents: {} }, { ...snapshot(), portAlerts: 'bad' }, { ...snapshot(), marineBulletins: undefined }]) {
    assert.notEqual(app.mapImdSnapshot(value as never).coverageState, 'ok', JSON.stringify(value));
  }
  // A malformed collection next to valid records is degraded, not ok.
  const partial = app.mapImdSnapshot({ ...snapshot(), marineBulletins: 'bad' } as never);
  assert.equal(partial.coverageState, 'degraded');
  assert.equal(partial.cycloneEvents.length, 1);
  assert.equal(partial.portAlerts.length, 1);
});

test('records with invalid dates are rejected instead of stamped with generatedAt', () => {
  for (const date of ['bad', null, undefined, 0, -1, 9e99, Number.NaN]) {
    assert.equal(app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [{ ...event, date }] } as never).cycloneEvents.length, 0, `date ${String(date)}`);
  }
  for (const invalid of [{ ...alert, onset: 'bad' }, { ...alert, expires: 9e99 }, { ...alert, onset: undefined }, { ...alert, expires: null }]) {
    assert.equal(app.mapImdSnapshot({ ...snapshot(), portAlerts: [invalid] } as never).portAlerts.length, 0);
    assert.equal(app.mapImdSnapshot({ ...snapshot(), marineBulletins: [invalid] } as never).marineBulletins.length, 0);
  }
  const iso = app.mapImdSnapshot({ ...snapshot(), portAlerts: [{ ...alert, onset: '2026-09-15T11:00:00Z', expires: '2026-09-15T13:00:00Z' }] } as never);
  assert.equal(iso.portAlerts[0]?.onset.getTime(), Date.parse('2026-09-15T11:00:00Z'));
});

test('rejected records downgrade coverage: degraded while some survive, unavailable when none do', () => {
  const some = app.mapImdSnapshot({ ...snapshot(), portAlerts: [alert, { ...alert, id: 'bad-date', onset: 'bad' }] } as never);
  assert.equal(some.coverageState, 'degraded');
  assert.deepEqual(some.portAlerts.map((row) => row.id), ['port-test']);

  const none = app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [{ ...event, date: 'bad' }], portAlerts: [null], marineBulletins: [] } as never);
  assert.equal(none.coverageState, 'unavailable');

  for (const invalid of [null, {}, { ...event, lat: 91 }, { ...event, lon: Number.NaN }, { ...event, id: '' }]) {
    const mapped = app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [invalid, event] } as never);
    assert.equal(mapped.cycloneEvents.length, 1);
    assert.equal(mapped.coverageState, 'degraded', JSON.stringify(invalid));
  }

  // A degraded snapshot stays degraded; unknown states are not passed through.
  assert.equal(app.mapImdSnapshot({ ...snapshot(), coverageState: 'degraded' }).coverageState, 'degraded');
  assert.equal(app.mapImdSnapshot({ ...snapshot(), coverageState: 'totally-fine' }).coverageState, 'unavailable');
});

test('main mapper field handling is preserved: unsafe values and extra keys are dropped', () => {
  const result = app.mapImdSnapshot({ ...snapshot(), cycloneEvents: [{ ...event, windKt: '<img>', extra: 'untrusted', sourceUrl: 'https://evil.example', forecastTrack: [null, { lat: 15, lon: 80, hour: 12, windKt: 45, category: 0, extra: true }] }], portAlerts: [{ ...alert, wind: '20 kt', extra: true, sourceUrl: 'javascript:alert(1)' }] } as never);
  const storm = result.cycloneEvents[0]!;
  assert.equal(storm.windKt, undefined);
  assert.equal('extra' in storm, false);
  assert.equal(storm.sourceUrl, undefined);
  assert.deepEqual(storm.forecastTrack, [{ lat: 15, lon: 80, hour: 12, windKt: 45, category: 0, geometryKind: '' }]);
  assert.equal(result.portAlerts[0]!.wind, '20 kt');
  assert.equal('extra' in result.portAlerts[0]!, false);
  assert.equal(result.portAlerts[0]!.sourceUrl, undefined);
  assert.equal(result.sourceName, 'IMD');
  assert.equal(result.sourceUrl, 'https://rsmcnewdelhi.imd.gov.in/');
  assert.equal(result.coverageState, 'ok', 'field sanitizing is not a record rejection');
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
  // An unavailable, empty snapshot is not retained by the handoff: every call
  // goes back to the load path.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ data: { imdCycloneMarine: { ...snapshot(), coverageState: 'unavailable', cycloneEvents: [], portAlerts: [] } } });
  };
  await app.fetchImdCycloneMarine();
  await app.fetchImdCycloneMarine();
  assert.equal(calls, 2);
});
