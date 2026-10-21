import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHistory, computeWow } from '../scripts/seed-portwatch.mjs';
import { detectTrafficAnomaly } from '../shared/chokepoint-traffic-anomaly.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures');

function makeDays(count, dailyTotal, startOffset) {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.now() - (startOffset + i) * 86400000).toISOString().slice(0, 10),
    total: dailyTotal,
  }));
}

// The interface-export and seeder-config assertions that used to open this file
// restated declarations that typecheck already enforces. A string-matching
// `classifyVesselType` was also defined and tested here across five cases —
// production has no such function; the seeder reads numeric ArcGIS columns
// (n_tanker, n_container). Those tests could never fail.

describe('computeWow', () => {
  it('reports the week-over-week change to one decimal', () => {
    assert.equal(computeWow([...makeDays(7, 50, 0), ...makeDays(7, 40, 7)]), 25);
    assert.equal(computeWow([...makeDays(7, 40, 0), ...makeDays(7, 50, 7)]), -20);
  });

  it('reports no change when both weeks match', () => {
    assert.equal(computeWow([...makeDays(7, 50, 0), ...makeDays(7, 50, 7)]), 0);
  });

  it('returns 0 rather than dividing by an empty prior week', () => {
    assert.equal(computeWow([...makeDays(7, 50, 0), ...makeDays(7, 0, 7)]), 0);
  });

  it('returns 0 below the 14-day window it needs', () => {
    assert.equal(computeWow(makeDays(13, 50, 0)), 0);
    assert.equal(computeWow([]), 0);
  });

  it('compares the two most recent weeks regardless of input order', () => {
    const chronological = [...makeDays(7, 40, 7), ...makeDays(7, 50, 0)];
    assert.equal(computeWow(chronological), 25);
  });
});

describe('detectTrafficAnomaly', () => {
  it('flags a >50% drop at a war-zone chokepoint', () => {
    const result = detectTrafficAnomaly([...makeDays(7, 5, 0), ...makeDays(30, 100, 7)], 'war_zone');
    assert.ok(result.signal);
    assert.ok(result.dropPct >= 90, `expected >90% drop, got ${result.dropPct}%`);
  });

  it('does not flag the same drop at a normal chokepoint', () => {
    const result = detectTrafficAnomaly([...makeDays(7, 5, 0), ...makeDays(30, 100, 7)], 'normal');
    assert.equal(result.signal, false);
  });
});


// Golden fixture: upstream ArcGIS FeatureServer format regression guard
// ---------------------------------------------------------------------------

describe('golden fixture (PortWatch ArcGIS JSON)', () => {
  const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'portwatch-arcgis-sample.json'), 'utf-8'));

  it('fixture has features array', () => {
    assert.ok(Array.isArray(fixture.features), 'features should be an array');
    assert.ok(fixture.features.length >= 1, `expected >=1 feature, got ${fixture.features.length}`);
  });

  it('each feature has attributes with required fields', () => {
    for (const f of fixture.features) {
      assert.ok(f.attributes != null, 'attributes missing');
      assert.ok('date' in f.attributes, 'date missing');
      assert.ok('n_container' in f.attributes, 'n_container missing');
      assert.ok('n_dry_bulk' in f.attributes, 'n_dry_bulk missing');
      assert.ok('n_tanker' in f.attributes, 'n_tanker missing');
      assert.ok('n_total' in f.attributes, 'n_total missing');
      assert.ok('capacity_container' in f.attributes, 'capacity_container missing');
      assert.ok('capacity_tanker' in f.attributes, 'capacity_tanker missing');
    }
  });

  it('buildHistory produces entries with expected shape', () => {
    const history = buildHistory(fixture.features);
    assert.ok(history.length >= 1, 'expected >=1 history entry');
    const entry = history[0];
    assert.ok('date' in entry, 'date missing');
    assert.ok('container' in entry, 'container missing');
    assert.ok('dryBulk' in entry, 'dryBulk missing');
    assert.ok('tanker' in entry, 'tanker missing');
    assert.ok('total' in entry, 'total missing');
    assert.ok('cargo' in entry, 'cargo missing');
    assert.ok('capContainer' in entry, 'capContainer missing');
    assert.ok('capTanker' in entry, 'capTanker missing');
  });

  it('buildHistory date format is YYYY-MM-DD', () => {
    const history = buildHistory(fixture.features);
    for (const entry of history) {
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `date format wrong: ${entry.date}`);
    }
  });

  it('buildHistory total matches n_total from attributes', () => {
    const history = buildHistory(fixture.features);
    const expected = fixture.features[0].attributes;
    const entry = history.find(e => e.date === '2024-05-01');
    assert.ok(entry != null, 'entry for 2024-05-01 missing');
    assert.equal(entry.total, expected.n_total);
  });
});
