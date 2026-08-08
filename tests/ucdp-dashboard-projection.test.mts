import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UCDP_PANEL_ROWS_PER_TAB,
  classifyUcdpEvents,
  buildUcdpDedupeIndex,
  summarizeUcdpEvents,
  selectUcdpPanelRows,
  compactUcdpDashboardPayload,
} from '../scripts/_ucdp-dashboard.mjs';
import { deriveUcdpClassifications } from '../src/services/conflict/ucdp-classify.ts';
import { deduplicateUcdpProjectionAggregates, isDuplicatedByAcled } from '../src/services/conflict/ucdp-dedupe.ts';

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
  assert.equal(compact.dedupeIndex.length, events.length, 'dedupe index must cover the full pre-cap set');
  assert.deepEqual(compact.aggregates, summarizeUcdpEvents(events));
  assert.deepEqual(compact.classifications, classifyUcdpEvents(events, NOW));
  // Passthrough metadata is preserved.
  assert.equal(compact.version, '25.1');
  assert.equal(compact.fetchedAt, NOW);

  const before = JSON.stringify(full).length;
  const after = JSON.stringify(compact).length;
  assert.ok(after < before / 2, `projection should at least halve the payload (was ${before}, now ${after})`);
});

test('reconciles projection totals after ACLED de-duplication', () => {
  const events = fixture();
  const compact = compactUcdpDashboardPayload({ events }, NOW);
  const acledEvents = [{ latitude: 1, longitude: 2, event_date: new Date(NOW - DAY).toISOString(), fatalities: 1 }];
  const expectedAggregates = summarizeUcdpEvents(events
    .filter((event) => [
      'UCDP_VIOLENCE_TYPE_STATE_BASED',
      'UCDP_VIOLENCE_TYPE_NON_STATE',
      'UCDP_VIOLENCE_TYPE_ONE_SIDED',
    ].includes(event.violenceType))
    .filter((event) => !isDuplicatedByAcled({
      latitude: event.location.latitude,
      longitude: event.location.longitude,
      dateMs: event.dateStart,
      deathsBest: event.deathsBest,
    }, acledEvents)));

  assert.deepEqual(
    deduplicateUcdpProjectionAggregates(compact.aggregates, compact.dedupeIndex, acledEvents),
    expectedAggregates,
  );
  assert.deepEqual(compact.dedupeIndex, buildUcdpDedupeIndex(events));
});

test('tolerates malformed payloads rather than publishing garbage', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { events: 'not-an-array' }]) {
    assert.equal(compactUcdpDashboardPayload(bad as never, NOW), bad);
  }
});
