// The committed CII fixtures (tests/fixtures/cii/) as a regression snapshot
// and as the proof that the scoring seam reproduces production. See
// docs/methodology/cii-change-brief.md.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CII_FIXTURE_DIR,
  CII_FIXTURE_SCHEMA,
  expectedFromTable,
  loadCiiFixtures,
  scoreCiiFixture,
  trimCiiRawInputs,
} from '../scripts/lib/cii-fixtures.mts';
import { computeCiiScoreTable } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';

const FIXTURES = loadCiiFixtures();
const TIER1_NAMES = new Set(Object.values(TIER1_COUNTRIES));

describe('CII fixtures', () => {
  it('cover at least three production captures on at least two days, all in the current schema', () => {
    const files = readdirSync(CII_FIXTURE_DIR).filter((name) => name.endsWith('.json'));
    assert.equal(FIXTURES.length, files.length, 'every fixture file must use the current schema');
    assert.ok(new Set(FIXTURES.map((f) => f.capturedAt)).size >= 3, 'need three distinct captures');
    assert.ok(new Set(FIXTURES.map((f) => f.capturedAt.slice(0, 10))).size >= 2, 'need captures from two days');
    for (const f of FIXTURES) {
      assert.equal(f.schema, CII_FIXTURE_SCHEMA);
      assert.ok(files.includes(`${f.label}.json`), `${f.label} must be stored as ${f.label}.json`);
    }
  });

  it('stay small: under 1 MB in total', () => {
    const bytes = readdirSync(CII_FIXTURE_DIR).reduce((sum, name) => sum + statSync(join(CII_FIXTURE_DIR, name)).size, 0);
    assert.ok(bytes < 1024 * 1024, `fixtures total ${bytes} bytes`);
  });

  it('are already trimmed, and keep no strike-feed text or headline other than a country name', () => {
    for (const f of FIXTURES) {
      assert.deepEqual(trimCiiRawInputs(f.inputs), f.inputs, `${f.label} holds untrimmed inputs`);
      for (const event of (f.inputs.iranEvents as { events?: object[] } | null)?.events ?? []) {
        assert.deepEqual(Object.keys(event).sort(), ['countryCode', 'severity', 'timestamp'], `${f.label} strike event keeps extra fields`);
      }
      for (const story of (f.inputs.newsInsights as { topStories?: Array<{ primaryTitle: string }> } | null)?.topStories ?? []) {
        assert.ok(story.primaryTitle === '' || TIER1_NAMES.has(story.primaryTitle), `${f.label} keeps a headline`);
      }
    }
  });

  it(`reproduce the recorded ${CII_FORMULA_VERSION} table on every fixture`, () => {
    for (const f of FIXTURES) {
      const expected = f.expected[CII_FORMULA_VERSION];
      assert.ok(expected, `${f.label} has no ${CII_FORMULA_VERSION} table; record one with scripts/cii-table-diff.mts --write-expected`);
      assert.deepEqual(expectedFromTable(scoreCiiFixture(f)), expected,
        `${f.label}: scores moved without a CII_FORMULA_VERSION bump`);
    }
  });

  it('reproduce the table production stored, 31/31, wherever it was captured', () => {
    const proofs = FIXTURES.filter((f) => f.production?.methodologyVersion === CII_FORMULA_VERSION);
    if (CII_FORMULA_VERSION === 'v14') assert.ok(proofs.length >= 2, 'v14 has two production captures');
    for (const f of proofs) {
      const scores = Object.fromEntries(scoreCiiFixture(f).scores.map((s) => [s.region, s.combinedScore]));
      assert.equal(Object.keys(scores).length, 31);
      assert.deepEqual(scores, f.production!.scores, `${f.label}: the seam disagrees with ${f.production!.key}`);
    }
  });
});

describe('CII scoring seam', () => {
  it('reads no clock: Date.now is never called', () => {
    const f = FIXTURES.at(-1)!;
    const realNow = Date.now;
    Date.now = () => { throw new Error('the seam read the clock'); };
    try {
      computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
    } finally {
      Date.now = realNow;
    }
  });

  it('is deterministic and reports every term behind each score', () => {
    const f = FIXTURES.at(-1)!;
    const a = computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
    const b = computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
    assert.deepEqual(a.rows, b.rows);
    assert.deepEqual(a.rows.map((r) => r.region), a.scores.map((s) => s.region));
    for (const row of a.rows) {
      const sum = row.baseline * 0.4 + row.eventScore * 0.6 + Object.values(row.boosts).reduce((s, x) => s + x, 0);
      assert.ok(Math.abs(sum - row.blended) < 1e-9, `${row.region}: the boosts do not sum to the blend`);
      assert.equal(row.combinedScore, Math.min(100, Math.max(row.floor, Math.round(row.blended))));
      assert.equal(row.floor, Math.max(...Object.values(row.floors)));
      assert.equal(row.bindingFloors.length > 0, row.floor > Math.round(row.blended));
    }
  });

  it('takes IRAN_EVENTS_ENABLED as a parameter: off ignores the strike feed and its tally', () => {
    const f = FIXTURES.at(-1)!;
    const off = computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: false });
    const stripped = computeCiiScoreTable({ ...f.inputs, iranEvents: null, strikePressure: null }, { nowMs: f.nowMs, iranEventsEnabled: true });
    assert.deepEqual(off.rows, stripped.rows);
    assert.equal(off.aux.inputReads?.iranEvents, 'not_configured');
  });
});
