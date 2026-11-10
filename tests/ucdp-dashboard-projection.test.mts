import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UCDP_PANEL_ROWS_PER_TAB,
  classifyUcdpEvents,
  summarizeUcdpEvents,
  selectUcdpPanelRows,
  selectUcdpExposureRows,
  compactUcdpDashboardPayload,
} from '../scripts/_ucdp-dashboard.mjs';
import { deriveUcdpClassifications } from '../src/services/conflict/ucdp-classify.ts';
import { enrichEventsWithExposure } from '../src/services/population-exposure.ts';
import { PRIORITY_COUNTRIES } from '../shared/analysis-population-exposure.ts';

const NOW = Date.parse('2026-07-14T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Deterministic fixture spanning every branch of the classifier. */
function fixture(): any[] {
  const events: any[] = [];
  const push = (country: string, type: string, deaths: number, ageDays: number, sideA: string, sideB: string, i: number) => {
    events.push({
      id: `${country}-${i}`,
      country,
      violenceType: type,
      deathsBest: deaths,
      deathsLow: deaths,
      deathsHigh: deaths,
      dateStart: NOW - ageDays * DAY,
      dateEnd: NOW - ageDays * DAY,
      sideA, sideB,
      location: { latitude: 1, longitude: 2 },
      sourceOriginal: 'x'.repeat(40),
    });
  };

  // 'war' via the deaths threshold (>1000)
  for (let i = 0; i < 5; i++) push('Warland', 'UCDP_VIOLENCE_TYPE_STATE_BASED', 400, 10 + i, 'GovA', 'RebelA', i);
  // 'war' via the event-count threshold (>100)
  for (let i = 0; i < 120; i++) push('Countryland', 'UCDP_VIOLENCE_TYPE_NON_STATE', 1, 5 + (i % 30), 'MilA', 'MilB', i);
  // 'minor' (>10 events, under both war thresholds)
  for (let i = 0; i < 15; i++) push('Minorland', 'UCDP_VIOLENCE_TYPE_ONE_SIDED', 2, 20 + i, 'GovC', 'CivC', i);
  // 'none' (few events)
  for (let i = 0; i < 3; i++) push('Quietland', 'UCDP_VIOLENCE_TYPE_STATE_BASED', 1, 30 + i, 'GovD', 'RebelD', i);
  // outside the trailing 2-year window — must be excluded from classification
  for (let i = 0; i < 50; i++) push('Staleland', 'UCDP_VIOLENCE_TYPE_STATE_BASED', 999, 900 + i, 'GovE', 'RebelE', i);
  // an unspecified violence type — not a panel tab, must not break the summary
  push('Oddland', 'UCDP_VIOLENCE_TYPE_UNSPECIFIED', 7, 3, 'GovF', 'RebelF', 0);

  // Bulk, in production proportions (~1,266 state-based / 505 non-state / 229
  // one-sided out of 2,000). Without this the fixture is smaller than the 50-row
  // cap and the size assertion below would prove nothing.
  for (let i = 0; i < 1200; i++) push('Bulkland', 'UCDP_VIOLENCE_TYPE_STATE_BASED', 1, 1 + (i % 300), 'GovX', 'RebelX', i);
  for (let i = 0; i < 380; i++) push('Bulkstan', 'UCDP_VIOLENCE_TYPE_NON_STATE', 1, 1 + (i % 300), 'MilX', 'MilY', i);
  for (let i = 0; i < 210; i++) push('Bulkovia', 'UCDP_VIOLENCE_TYPE_ONE_SIDED', 1, 1 + (i % 300), 'GovZ', 'CivZ', i);

  events.sort((a, b) => b.dateStart - a.dateStart); // seeder publishes newest-first
  return events;
}

// ── THE DRIFT GUARD ─────────────────────────────────────────────────────────
// scripts/_ucdp-dashboard.mjs mirrors deriveUcdpClassifications because it cannot
// import it: Railway builds seeders from a scripts-only Nixpacks root and a
// `../src/` import crashes the container at startup (#5268). Duplicated scoring
// logic is how silent data drift happens — CII intensity would quietly diverge
// from what the client would have computed, and nothing would alarm. Run both
// over the same events and demand identical output.
test('seeder classifier is identical to the client classifier (drift guard)', () => {
  const events = fixture();

  const fromSeeder = classifyUcdpEvents(events, NOW);
  const fromClient = deriveUcdpClassifications(events as never, NOW);

  assert.deepEqual(
    Object.keys(fromSeeder).sort(),
    [...fromClient.keys()].sort(),
    'seeder and client disagree on which countries are classified',
  );

  for (const [country, clientStatus] of fromClient) {
    assert.deepEqual(
      fromSeeder[country],
      { ...clientStatus },
      `classification drift for ${country} — scripts/_ucdp-dashboard.mjs and src/services/conflict/index.ts must stay in lockstep`,
    );
  }
});

test('classifier honours the trailing-2-year window', () => {
  const c = classifyUcdpEvents(fixture(), NOW);
  // Staleland's 50 high-death events are all >2y old ⇒ nothing recent ⇒ 'none'.
  assert.equal(c.Staleland.intensity, 'none');
  assert.equal(c.Warland.intensity, 'war');      // 5 × 400 = 2000 deaths > 1000
  assert.equal(c.Countryland.intensity, 'war');  // 120 events > 100
  assert.equal(c.Minorland.intensity, 'minor');  // 15 events > 10
  assert.equal(c.Quietland.intensity, 'none');   // 3 events
});

// ── THE PANEL CONTRACT ──────────────────────────────────────────────────────
// UcdpEventsPanel renders filtered.slice(0, 50) per violence tab, but computes its
// tab counts and total-deaths figures over the FULL event set. Capping the array
// without precomputing those aggregates would silently change numbers on screen.
test('aggregates are computed over every event, not the capped rows', () => {
  const events = fixture();
  const agg = summarizeUcdpEvents(events);

  for (const type of ['UCDP_VIOLENCE_TYPE_STATE_BASED', 'UCDP_VIOLENCE_TYPE_NON_STATE', 'UCDP_VIOLENCE_TYPE_ONE_SIDED']) {
    const all = events.filter(e => e.violenceType === type);
    assert.equal(agg[type].count, all.length, `${type} count must match the full set`);
    assert.equal(agg[type].totalDeaths, all.reduce((s, e) => s + e.deathsBest, 0), `${type} deaths must match the full set`);
  }
  // The panel has no tab for UNSPECIFIED; it must not appear or throw.
  assert.equal(agg.UCDP_VIOLENCE_TYPE_UNSPECIFIED, undefined);
});

test('keeps the newest N rows PER violence type, in publish order', () => {
  const events = fixture();
  const rows = selectUcdpPanelRows(events, UCDP_PANEL_ROWS_PER_TAB);

  for (const type of ['UCDP_VIOLENCE_TYPE_STATE_BASED', 'UCDP_VIOLENCE_TYPE_NON_STATE', 'UCDP_VIOLENCE_TYPE_ONE_SIDED']) {
    const keptOfType = rows.filter(e => e.violenceType === type);
    const allOfType = events.filter(e => e.violenceType === type);
    const expected = Math.min(allOfType.length, UCDP_PANEL_ROWS_PER_TAB);

    assert.equal(keptOfType.length, expected, `${type}: expected ${expected} rows`);
    // The panel filters by tab then slices — so the kept rows must be the exact
    // prefix it would have displayed from the full array.
    assert.deepEqual(keptOfType.map(e => e.id), allOfType.slice(0, expected).map(e => e.id));
  }
});

test('projection shrinks the payload while preserving every displayed number', () => {
  const events = fixture();
  const full = { events, fetchedAt: NOW, version: '25.1', totalRaw: 9999, filteredCount: events.length };
  const compact = compactUcdpDashboardPayload(full, NOW);

  assert.ok(compact.events.length < events.length, 'events must be capped');
  assert.equal(compact.totalEvents, events.length, 'pre-cap total must be recorded');
  assert.equal('dedupeIndex' in compact, false, 'no reader remains for a client-side ACLED dedupe index (#8588)');
  assert.deepEqual(compact.aggregates, summarizeUcdpEvents(events));
  assert.deepEqual(compact.classifications, classifyUcdpEvents(events, NOW));
  // Passthrough metadata is preserved.
  assert.equal(compact.version, '25.1');
  assert.equal(compact.fetchedAt, NOW);

  const before = JSON.stringify(full).length;
  const after = JSON.stringify(compact).length;
  assert.ok(after < before / 2, `projection should at least halve the payload (was ${before}, now ${after})`);
});

test('selects eligible exposure rows before the independent panel cap', () => {
  const point = { ...fixture()[0], country: 'Yemen (North Yemen)', hasPreciseLocation: true };
  const panelRows = Array.from({ length: UCDP_PANEL_ROWS_PER_TAB }, (_, i) => ({
    ...point, id: `panel-${i}`, hasPreciseLocation: false,
  }));
  const eligible = Array.from({ length: 12 }, (_, i) => ({
    ...point, id: `exposure-${i}`, location: { latitude: 13 + i, longitude: 44 },
  }));
  const events = [
    ...panelRows,
    { ...point, country: 'Chile' },
    { ...point, location: { latitude: 91, longitude: 10 } },
    { ...point, location: { latitude: 0, longitude: 0 } },
    ...eligible,
  ];
  const compact = compactUcdpDashboardPayload({ events }, NOW);
  assert.deepEqual(compact.events, panelRows);
  assert.deepEqual(compact.exposureEvents, eligible.slice(0, 10).map(e => ({ ...e, exposureEventCount: 1 })));
  assert.deepEqual(compact.aggregates, summarizeUcdpEvents(events));
});

test('spends the exposure slots on distinct locations and counts every event at each', () => {
  const point = { ...fixture()[0], country: 'Ukraine', hasPreciseLocation: true };
  const at = (id: string, latitude: number, longitude = 30.52333) => ({ ...point, id, location: { latitude, longitude } });
  const events = [
    at('643820', 50.45),
    at('643824', 50.45),
    ...Array.from({ length: 10 }, (_, i) => at(`other-${i}`, 40 + i)),
    at('643899', 50.4500004),
    { ...at('broad', 50.45), hasPreciseLocation: false },
  ];
  const { exposureEvents, exposureCoverage } = compactUcdpDashboardPayload({ events }, NOW);
  assert.deepEqual(exposureEvents.map((e: any) => [e.id, e.exposureEventCount]), [
    ['643820', 3],
    ...Array.from({ length: 9 }, (_, i) => [`other-${i}`, 1]),
  ]);

  const toExposureInput = (e: any) => ({
    id: e.id, name: e.id, type: 'conflict', country: e.country, hasPreciseLocation: e.hasPreciseLocation,
    lat: e.location.latitude, lon: e.location.longitude, eventCount: e.exposureEventCount,
  });
  const fromFullFeed = enrichEventsWithExposure(events.map(e => toExposureInput({ ...e, exposureEventCount: undefined })), 10);
  const fromProjection = enrichEventsWithExposure(exposureEvents.map(toExposureInput), 10);
  assert.deepEqual(fromProjection.exposures, fromFullFeed.exposures);
  assert.deepEqual(exposureCoverage, fromFullFeed.coverage);
  assert.deepEqual(exposureCoverage, { totalEvents: 14, withoutPreciseLocation: 1, withoutEstimate: 0, atOtherPlaces: 1 });
});

test('counts the feed events the exposure rows leave out, as the dashboard does', () => {
  const point = { ...fixture()[0], country: 'Yemen (North Yemen)', hasPreciseLocation: true };
  const events = [
    ...Array.from({ length: 12 }, (_, i) => ({ ...point, id: `exposure-${i}`, location: { latitude: 13 + i, longitude: 44 } })),
    { ...point, id: 'chile', country: 'Chile' },
    { ...point, id: 'no-country', country: undefined },
    { ...point, id: 'invalid', location: { latitude: 91, longitude: 10 } },
    { ...point, id: 'null-island', location: { latitude: 0, longitude: 0 } },
    { ...point, id: 'broad', hasPreciseLocation: false },
  ];
  const { exposureCoverage } = compactUcdpDashboardPayload({ events }, NOW);
  assert.deepEqual(exposureCoverage, { totalEvents: 17, withoutPreciseLocation: 1, withoutEstimate: 4, atOtherPlaces: 2 });

  const asInput = events.map(e => ({
    id: e.id, name: e.id, type: 'conflict', country: e.country, hasPreciseLocation: e.hasPreciseLocation,
    lat: e.location.latitude, lon: e.location.longitude,
  }));
  assert.deepEqual(enrichEventsWithExposure(asInput, 10).coverage, exposureCoverage);
});

// Every country label in UCDP GED 25.1 (fetched per Gleditsch-Ward code on 2026-11-10).
// The projection cannot import the dashboard's resolver, so the two must agree on these.
const UCDP_COUNTRY_LABELS = [
  'Afghanistan', 'Albania', 'Algeria', 'Angola', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan',
  'Bahrain', 'Bangladesh', 'Belgium', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia-Herzegovina', 'Botswana', 'Brazil',
  'Burkina Faso', 'Burundi', 'Cambodia (Kampuchea)', 'Cameroon', 'Canada', 'Central African Republic', 'Chad',
  'China', 'Colombia', 'Comoros', 'Congo', 'Croatia', 'DR Congo (Zaire)', 'Djibouti', 'Ecuador', 'Egypt',
  'El Salvador', 'Eritrea', 'Ethiopia', 'France', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Guatemala', 'Guinea',
  'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'India', 'Indonesia', 'Iran', 'Iraq', 'Israel', 'Italy',
  'Ivory Coast', 'Jamaica', 'Jordan', 'Kenya', 'Kingdom of eSwatini (Swaziland)', 'Kuwait', 'Kyrgyzstan', 'Laos',
  'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Madagascar (Malagasy)', 'Malaysia', 'Mali', 'Malta', 'Mauritania',
  'Mexico', 'Moldova', 'Morocco', 'Mozambique', 'Myanmar (Burma)', 'Namibia', 'Nepal', 'Netherlands', 'Nicaragua',
  'Niger', 'Nigeria', 'North Macedonia', 'Pakistan', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru',
  'Philippines', 'Poland', 'Qatar', 'Romania', 'Russia (Soviet Union)', 'Rwanda', 'Saudi Arabia', 'Senegal',
  'Serbia (Yugoslavia)', 'Sierra Leone', 'Solomon Islands', 'Somalia', 'South Africa', 'South Sudan', 'Spain',
  'Sri Lanka', 'Sudan', 'Sweden', 'Syria', 'Tajikistan', 'Tanzania', 'Thailand', 'Togo', 'Trinidad and Tobago',
  'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States of America',
  'Uzbekistan', 'Venezuela', 'Yemen (North Yemen)', 'Zambia', 'Zimbabwe (Rhodesia)',
];

test('seeded exposure eligibility agrees with the dashboard for UCDP country labels', () => {
  const countries = [
    ...Object.entries(PRIORITY_COUNTRIES).flatMap(([code, { name }]) => [code, name]),
    ...UCDP_COUNTRY_LABELS,
    'Chile', 'Unknown',
  ];
  for (const country of countries) {
    const point = { id: 'point', country, location: { latitude: 1, longitude: 2 }, hasPreciseLocation: true };
    const [projected] = selectUcdpExposureRows([point]).rows;
    const [estimate] = enrichEventsWithExposure([{ ...point, name: country, type: 'conflict', lat: 1, lon: 2 }]).exposures;
    assert.equal(Boolean(projected), Boolean(estimate), country);
  }
});

test('bootstrap projection size does not grow with the full event count', () => {
  // #8587 keeps every candidate row, so the full set can grow well past 2,000.
  // The bootstrap key must stay bounded by the capped panel rows, not the total.
  const events = fixture();
  const grown = [...events, ...events.map((e, i) => ({ ...e, id: `${e.id}-extra-${i}` }))];
  const bytes = (list: any[]) => JSON.stringify(compactUcdpDashboardPayload({ events: list, fetchedAt: NOW }, NOW)).length;
  const growth = bytes(grown) - bytes(events);
  assert.ok(growth < 2_000, `doubling the event count grew the bootstrap projection by ${growth} bytes`);
});

test('tolerates malformed payloads rather than publishing garbage', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { events: 'not-an-array' }]) {
    assert.equal(compactUcdpDashboardPayload(bad as never, NOW), bad);
  }
});
