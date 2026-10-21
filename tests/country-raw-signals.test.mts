import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleRawSignals, failedRawSignal, validateRawSignal, projectRawSignals, rawSignalsResultSchema, type RawSignalsValue } from '../shared/country-raw-signals';

const retrievedAt = '2026-10-05T12:00:00.000Z';
const quake = { id: 'eq', place: 'United States \"測\" \\ quake', magnitude: 4.5, location: { latitude: 38, longitude: -77 }, occurredAt: 1791000000000, source: 'USGS', category: 'earthquake', sourceUrl: 'https://example.com/eq' };
const outage = { id: 'out', title: 'Curated outage', country: 'United States', location: { latitude: 0, longitude: 0 }, detectedAt: 1791000000000, endedAt: 1791000300000, link: 'https://example.com/out' };
const advisory = { title: 'Publisher observation', link: 'https://example.com/advisory', source: 'US State Dept', sourceCountry: 'US', pubDate: '2026-10-01T12:00:00Z', level: 'caution', country: 'US' };
const thermal = { id: 'hot', countryCode: 'US', status: 'THERMAL_STATUS_SPIKE', firstDetectedAt: '2026-10-01T12:00:00Z', lastDetectedAt: '2026-10-01T15:00:00Z' };
const byCountry = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`C${index}`, 'caution']));
const watch = (clusters: unknown[]) => ({ clusters, fetchedAt: '2026-10-01T16:00:00Z', observationWindowHours: 24, sourceVersion: 'thermal-escalation-v1' });

it('accepts actual USGS producer events without an NRCan-only category and preserves their observations', async () => {
  const { parseUsgsGeojson } = await import('../scripts/seismology/nrcan-atom.mjs');
  const { earthquakes } = parseUsgsGeojson({ features: [{ id: quake.id, properties: { place: quake.place, mag: quake.magnitude, time: quake.occurredAt, url: quake.sourceUrl }, geometry: { coordinates: [quake.location.longitude, quake.location.latitude, 10] } }] });
  assert.equal(Object.hasOwn(earthquakes[0], 'category'), false);
  for (const category of [undefined, '', 'known earthquake']) {
    const row = category === undefined ? earthquakes[0] : { ...earthquakes[0], category };
    const sources = { earthquakes: validateRawSignal('earthquakes', JSON.parse(JSON.stringify({ earthquakes: [row] })), retrievedAt), outages: failedRawSignal('outages', 'unavailable', retrievedAt, 'Not requested'), advisories: failedRawSignal('advisories', 'unavailable', retrievedAt, 'Not requested'), thermal: failedRawSignal('thermal', 'unavailable', retrievedAt, 'Not requested') };
    const result = assembleRawSignals('US', sources, retrievedAt);
    assert.equal(sources.earthquakes.state, 'observed');
    assert.equal(sources.earthquakes.partial, false);
    assert.equal(rawSignalsResultSchema.safeParse(result).success, true);
    assert.equal(projectRawSignals(result.value, 'United States', true, () => true).earthquakes, 1);
    assert.equal(sources.earthquakes.records![0]!.occurredAt, quake.occurredAt);
    assert.equal(sources.earthquakes.records![0]!.source, 'usgs');
    assert.equal(sources.earthquakes.records![0]!.category, category ?? '');
  }
});

it('rejects invalid earthquake category types and keeps mixed exact counts unknown', () => {
  for (const category of [null, 1, {}, 'x'.repeat(201)]) {
    const invalid = { ...quake, category };
    assert.equal(validateRawSignal('earthquakes', { earthquakes: [invalid] }, retrievedAt).state, 'unavailable');
    const mixed = sample({ earthquakes: { earthquakes: [quake, invalid] } });
    assert.equal(mixed.value.sources.earthquakes.partial, true);
    assert.equal(projectRawSignals(mixed.value, 'United States', true, () => true).earthquakes, null);
  }
});
function sample(overrides: Partial<Record<keyof RawSignalsValue['sources'], unknown>> = {}) {
  const bodies = { earthquakes: { earthquakes: [quake] }, outages: { outages: [outage] }, advisories: { advisories: [advisory], byCountry }, thermal: watch([thermal]), ...overrides };
  const sources = Object.fromEntries(Object.entries(bodies).map(([family, body]) => [family, validateRawSignal(family as keyof typeof bodies, body, retrievedAt)])) as RawSignalsValue['sources'];
  return assembleRawSignals('US', sources, retrievedAt);
}

it('projects only attributed returned observations and keeps original clocks and native levels', () => {
  const result = sample();
  assert.equal(rawSignalsResultSchema.safeParse(result).success, true);
  assert.deepEqual(projectRawSignals(result.value, 'United States', true, (lat, lon) => lat === 38 && lon === -77), { earthquakes: 1, outages: 1, travelAdvisories: 1, travelAdvisoryMaxLevel: 'caution', thermalEscalations: 1 });
  assert.equal(result.value.sources.earthquakes.records![0]!.occurredAt, quake.occurredAt);
  assert.equal(result.value.sources.outages.records![0]!.endedAt, outage.endedAt);
  assert.equal(result.value.sources.advisories.records![0]!.pubDate, advisory.pubDate);
  assert.equal(result.value.sources.thermal.computationAt, '2026-10-01T16:00:00Z');
  assert.ok(Object.values(result.value.sources).every(source => source.snapshotAt === null));
  assert.match(result.value.sources.thermal.attribution, /FIRMS.*CWFIS.*British Columbia/);
});

it('preserves known geometry success and zero regardless of place text', () => {
  const result = sample();
  assert.equal(projectRawSignals(result.value, 'United States', true, () => false).earthquakes, 0);
  assert.equal(projectRawSignals(result.value, 'other', true, () => true).earthquakes, 1);
});

it('keeps earthquake attribution unknown without geometry even for positive country text', () => {
  const result = sample();
  assert.equal(projectRawSignals(result.value, 'United States', false, () => false).earthquakes, null);
});

for (const { countryCode, countryName, place, location } of [
  { countryCode: 'IN', countryName: 'India', place: 'Southern Indian Ocean', location: { latitude: -40, longitude: 70 } },
  { countryCode: 'GN', countryName: 'Guinea', place: 'Papua New Guinea', location: { latitude: -6, longitude: 147 } },
]) {
  it(`keeps ${countryName} earthquake attribution unknown for ${place} without geometry`, () => {
    const result = sample({ earthquakes: { earthquakes: [{ ...quake, place, location }] } });
    const value = { ...result.value, countryCode };
    assert.equal(rawSignalsResultSchema.safeParse({ ...result, value }).success, true);
    assert.equal(projectRawSignals(value, countryName, false, () => false).earthquakes, null);
  });
}

it('applies conservative global-empty semantics separately from valid returned-list zero', () => {
  const result = sample({ earthquakes: { earthquakes: [] }, outages: { outages: [] }, advisories: { advisories: [], byCountry: {} }, thermal: watch([]) });
  assert.deepEqual(result.value.missing, ['earthquakes', 'thermal']);
  assert.deepEqual(projectRawSignals(result.value, 'United States', false, () => false), { earthquakes: null, outages: 0, travelAdvisories: 0, travelAdvisoryMaxLevel: null, thermalEscalations: null });
  assert.match(result.value.sources.advisories.scope, /Producer success is unknown/);
});

it('uses the first global thermal sample before country filter and permits unmatched XX', () => {
  const result = sample({ thermal: watch([...Array.from({ length: 12 }, (_, index) => ({ ...thermal, id: `other${index}`, countryCode: 'XX' })), thermal]) });
  assert.equal(result.value.sources.thermal.state, 'observed');
  assert.equal(result.value.sources.thermal.records!.length, 12);
  assert.equal(projectRawSignals(result.value, 'United States', true, () => true).thermalEscalations, 0);
  assert.equal(sample({ thermal: { ...watch([thermal]), dataAvailable: false } }).value.sources.thermal.state, 'unavailable');
});

it('counts sampled advisory rows instead of the full index and ranks native levels independently', () => {
  const result = sample({ advisories: { advisories: [{ ...advisory, level: 'info' }], byCountry: { ...byCountry, US: 'do-not-travel' } } });
  const counts = projectRawSignals(result.value, 'United States', true, () => true);
  assert.equal(counts.travelAdvisories, 1);
  assert.equal(counts.travelAdvisoryMaxLevel, 'info');
});

it('ranks each observed native advisory level above unset and retains the highest selected-country level', () => {
  const levels = ['info', 'normal', 'caution', 'reconsider', 'do-not-travel'];
  for (const level of levels) {
    for (const rows of [[{ ...advisory, level }], [...levels.map(candidate => ({ ...advisory, level: candidate })), { ...advisory, level: 'info' }]]) {
      const result = sample({ advisories: { advisories: rows, byCountry } });
      assert.equal(projectRawSignals(result.value, 'United States', true, () => true).travelAdvisoryMaxLevel, rows.length === 1 ? level : 'do-not-travel');
    }
  }
});

it('marks malformed rows partial and makes exact family counts unknown', () => {
  for (const [family, body] of Object.entries({ earthquakes: { earthquakes: [quake, { ...quake, location: { latitude: 999, longitude: 0 } }] }, outages: { outages: [outage, {}] }, advisories: { advisories: [advisory, {}], byCountry }, thermal: watch([thermal, { ...thermal, status: 'UNKNOWN' }]) })) {
    const result = sample({ [family]: body });
    assert.equal(result.value.sources[family as keyof RawSignalsValue['sources']].partial, true, family);
    assert.ok(result.value.missing.includes(family as keyof RawSignalsValue['sources']));
    const counts = projectRawSignals(result.value, 'United States', true, () => true);
    const field = { earthquakes: 'earthquakes', outages: 'outages', advisories: 'travelAdvisories', thermal: 'thermalEscalations' }[family]!;
    assert.equal(counts[field as keyof typeof counts], null);
  }
});

it('rejects native clocks outside JavaScript date range before coverage composition', () => {
  for (const family of ['earthquakes', 'outages'] as const) {
    const body = family === 'earthquakes' ? { earthquakes: [{ ...quake, occurredAt: 8.64e15 + 1 }] } : { outages: [{ ...outage, detectedAt: 8.64e15 + 1 }] };
    assert.equal(validateRawSignal(family, body, retrievedAt).state, 'unavailable');
  }
});

it('rejects excess curated outage/advisory sample sizes and unknown native advisory levels', () => {
  assert.equal(validateRawSignal('outages', { outages: Array.from({ length: 51 }, () => outage) }, retrievedAt).state, 'unavailable');
  assert.equal(validateRawSignal('advisories', { advisories: Array.from({ length: 16 }, () => advisory), byCountry }, retrievedAt).state, 'unavailable');
  assert.equal(validateRawSignal('advisories', { advisories: [{ ...advisory, level: 'made-up-level' }], byCountry }, retrievedAt).state, 'unavailable');
});

it('rejects forged observed-empty or excess samples at the host result boundary', () => {
  for (const family of ['earthquakes', 'thermal'] as const) {
    const result = sample(); result.value.sources[family].records = []; result.value.sources[family].partial = true; result.value.missing = [family];
    assert.equal(rawSignalsResultSchema.safeParse(result).success, false, family);
  }
  const result = sample(); result.value.sources.outages.records = Array.from({ length: 51 }, () => outage);
  assert.equal(rawSignalsResultSchema.safeParse(result).success, false);
});

it('preserves all-denied and all-failed typed outcomes with consistent missing and top states', () => {
  const result = sample();
  for (const state of ['locked', 'unavailable'] as const) {
    const sources = Object.fromEntries(Object.keys(result.value.sources).map(family => [family, failedRawSignal(family as keyof RawSignalsValue['sources'], state, retrievedAt, 'Controlled failure')])) as RawSignalsValue['sources'];
    const failed = assembleRawSignals('US', sources, retrievedAt);
    assert.equal(failed.state, state);
    assert.equal(rawSignalsResultSchema.safeParse(failed).success, true);
    assert.equal(failed.value.missing.length, 4);
  }
});


it('requires a named selected country while preserving legitimate territories and unmatched thermal XX', async () => {
  const { COUNTRY_READERS } = await import('../shared/country-brief-host');
  for (const country_code of ['US', 'CN', 'CX', 'TK', 'BV', 'SJ', 'YT', 'RE', 'MQ', 'GP']) assert.equal(COUNTRY_READERS.signalsRaw.args.safeParse({ country_code }).success, true, country_code);
  for (const country_code of ['XX', 'ZZ', 'AA', 'EU', 'UN', 'EZ', 'QO', 'XA', 'XB', 'USA', 'U', 'USxx', 'us']) assert.equal(COUNTRY_READERS.signalsRaw.args.safeParse({ country_code }).success, false, country_code);
});
