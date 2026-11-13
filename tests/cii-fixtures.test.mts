// The committed CII fixtures (tests/fixtures/cii/) as a regression snapshot
// and as the proof that the scoring seam reproduces production. See
// docs/methodology/cii-change-brief.md.
import { summarizeUcdpWindow } from '../scripts/shared/ucdp-candidate.cjs';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CII_FIXTURE_DIR,
  CII_FIXTURE_SCHEMA,
  CII_EXPANDED_CAPTURE_TARGETS,
  validateCiiCalibrationInputs,
  buildCiiFixture,
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

it('capture targets retain the six future countries without changing the released table', () => {
  const extra = ['PH', 'TH', 'ID', 'VN', 'MY', 'KH'];
  const names = ['Philippines', 'Thailand', 'Indonesia', 'Vietnam', 'Malaysia', 'Cambodia'];
  const f = FIXTURES.at(-1)!;
  const raw = { ...f.inputs,
    ucdp: { events: names.map((country) => ({ country, dateStart: f.nowMs, deathsBest: 5 })) },
    gdeltCountryEvents: { byCountry: Object.fromEntries(extra.map((code) => [code, { conflict: [2, 1], protest: [3, 1] }])) },
    outages: { outages: extra.map((countryCode) => ({ countryCode, severity: 'major', detectedAt: f.nowMs - 60_000, endedAt: f.nowMs })) },
    structuralPrior: { countries: { PH: { pv: -0.5 }, ZZ: { pv: 1 } } },
  };
  const targets = [...Object.keys(TIER1_COUNTRIES), ...extra];
  const trimmed = trimCiiRawInputs(raw, targets);
  assert.equal((trimmed.ucdp as any).events.length, 6);
  assert.deepEqual(Object.keys((trimmed.gdeltCountryEvents as any).byCountry), extra);
  assert.deepEqual(trimmed.structuralPrior, raw.structuralPrior);
  assert.deepEqual(trimmed.outages, raw.outages);
  const options = { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled };
  assert.deepEqual(computeCiiScoreTable(trimmed, options).rows, computeCiiScoreTable(raw, options).rows);
  assert.equal(computeCiiScoreTable(trimmed, options).rows.length, 31);
  assert.throws(() => trimCiiRawInputs(raw, ['PH']), /omits released country/);
  assert.throws(() => trimCiiRawInputs(raw, [...targets, 'invalid']), /invalid capture target/);
  assert.throws(() => trimCiiRawInputs(raw, [...targets, 'ZZ']), /invalid capture target/);
  const saved = JSON.parse(JSON.stringify(buildCiiFixture(raw, {
    label: 'expanded-test', capturedAt: f.capturedAt, nowMs: f.nowMs,
    iranEventsEnabled: f.iranEventsEnabled, notes: [], production: null, targetCodes: targets,
  })));
  assert.deepEqual(saved.captureTargets, targets);
  assert.deepEqual(trimCiiRawInputs(saved.inputs, saved.captureTargets), saved.inputs);
});

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

  it('keep regression snapshots under 1 MB and each full calibration capture under 2 MB', () => {
    for (const f of FIXTURES.filter(f => f.calibration)) {
      assert.ok(statSync(join(CII_FIXTURE_DIR, `${f.label}.json`)).size < 2 * 1024 * 1024, `${f.label} exceeds 2 MB`);
      validateCiiCalibrationInputs(f.inputs, f.captureTargets ?? []);
    }
    const bytes = FIXTURES.filter(f => !f.calibration).reduce((sum, f) => sum + statSync(join(CII_FIXTURE_DIR, `${f.label}.json`)).size, 0);
    assert.ok(bytes < 1024 * 1024, `fixtures total ${bytes} bytes`);
  });

  it('are already trimmed, and keep no strike-feed text or headline other than a country name', () => {
    for (const f of FIXTURES) {
      assert.deepEqual(trimCiiRawInputs(f.inputs, f.captureTargets, f.calibration), f.inputs, `${f.label} holds untrimmed inputs`);
      if (!f.captureTargets) assert.equal(JSON.stringify(trimCiiRawInputs(f.inputs)), JSON.stringify(f.inputs), `${f.label} default bytes changed`);
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


it('capture and reader retain every full-window party group without changing v14', () => {
  const f = FIXTURES.at(-1)!;
  const partyMonths = [{ country: 'Ukraine', sideA: 'Government of Russia (Soviet Union)', sideB: 'Government of Ukraine', month: '2026-09', deaths: 123, events: 25 },
    { country: 'Philippines', sideA: '[unknown]', sideB: 'Rebels', month: '2026-08', deaths: 3, events: 1 }];
  const raw = { ...f.inputs, ucdp: { ...(f.inputs.ucdp as object), partyMonths, window: { complete: true } } };
  const trimmed = trimCiiRawInputs(raw);
  assert.deepEqual((trimmed.ucdp as any).partyMonths, partyMonths);
  const options = { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled };
  const original = computeCiiScoreTable(f.inputs, options);
  const table = computeCiiScoreTable(trimmed, options);
  assert.deepEqual(table.aux.ucdpPartyMonths, partyMonths);
  assert.deepEqual(table.rows, original.rows);
  assert.deepEqual(table.scores, original.scores);
});


it('calibration captures retain both maps and the entire UCDP payload', () => {
  const f = FIXTURES[0]!;
  const raw = { ...f.inputs,
    structuralPrior: { countries: Object.fromEntries(CII_EXPANDED_CAPTURE_TARGETS.map(code => [code, { pv: -0.5, year: 2024 }])) },
    economicStress: { schemaVersion: 1, countries: Object.fromEntries(Object.keys(TIER1_COUNTRIES).map(code => [code, { measured: false, members: {} }])) },
    ucdp: (() => {
      const startMs = Date.UTC(2025, 9, 1);
      const endMs = startMs + 365 * 86400000;
      const events = Array.from({ length: 11000 }, (_, i) => ({ country: 'Philippines', dateStart: startMs + (i % 366) * 86400000,
        deathsBest: i % 3, sideA: 'Government of Philippines', sideB: 'Rebels' }));
      const summary = summarizeUcdpWindow(events, { startMs, endMs });
      return { events, ...summary, window: { startMs, endMs, complete: true, gapMonths: summary.gapMonths, missingReleases: [], months: summary.months } };
    })(),
  };
  const trimmed = trimCiiRawInputs(raw, CII_EXPANDED_CAPTURE_TARGETS, true);
  assert.deepEqual(trimmed.ucdp, raw.ucdp);
  assert.deepEqual(trimmed.structuralPrior, raw.structuralPrior);
  assert.deepEqual(trimmed.economicStress, raw.economicStress);
  assert.doesNotThrow(() => validateCiiCalibrationInputs(trimmed, CII_EXPANDED_CAPTURE_TARGETS));
  const captured = buildCiiFixture(raw, { label: 'calibration-test', capturedAt: f.capturedAt, nowMs: f.nowMs,
    iranEventsEnabled: f.iranEventsEnabled, notes: [], production: null, targetCodes: CII_EXPANDED_CAPTURE_TARGETS, calibration: true });
  assert.equal(captured.calibration, true);
  assert.deepEqual(trimCiiRawInputs(captured.inputs, captured.captureTargets, captured.calibration), captured.inputs);
  assert.deepEqual(expectedFromTable(scoreCiiFixture(captured)), expectedFromTable(computeCiiScoreTable(raw, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled })));
  assert.throws(() => buildCiiFixture({ ...raw, economicStress: null }, { label: 'bad-calibration', capturedAt: f.capturedAt,
    nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled, notes: [], production: null, targetCodes: CII_EXPANDED_CAPTURE_TARGETS, calibration: true }), /economic/);
  assert.throws(() => validateCiiCalibrationInputs({ ...raw, economicStress: null }, CII_EXPANDED_CAPTURE_TARGETS), /economic/);
  assert.throws(() => validateCiiCalibrationInputs({ ...raw, structuralPrior: null }, CII_EXPANDED_CAPTURE_TARGETS), /prior/);
  assert.throws(() => validateCiiCalibrationInputs({ ...raw, ucdp: { ...raw.ucdp, partyMonths: [] } }, CII_EXPANDED_CAPTURE_TARGETS), /party/);
  assert.throws(() => validateCiiCalibrationInputs({ ...raw, ucdp: { ...raw.ucdp, window: { ...raw.ucdp.window, complete: false } } }, CII_EXPANDED_CAPTURE_TARGETS), /window/);
  assert.throws(() => validateCiiCalibrationInputs({ ...raw, ucdp: { ...raw.ucdp, dailyTotals: raw.ucdp.dailyTotals.slice(-60) } }, CII_EXPANDED_CAPTURE_TARGETS), /truncated/);
  assert.throws(() => validateCiiCalibrationInputs({ ...raw, ucdp: { ...raw.ucdp, countryDays: { Philippines: [[20362, 1, 1]] } } }, CII_EXPANDED_CAPTURE_TARGETS), /counts/);
  const shortStartMs = raw.ucdp.window.endMs - 340 * 86400000;
  const shortEvents = raw.ucdp.events.filter(e => e.dateStart >= shortStartMs);
  const shortSummary = summarizeUcdpWindow(shortEvents, { startMs: shortStartMs, endMs: raw.ucdp.window.endMs });
  const shortWindow = { ...raw, ucdp: { events: shortEvents, ...shortSummary,
    window: { ...raw.ucdp.window, startMs: shortStartMs, months: shortSummary.months, gapMonths: shortSummary.gapMonths } } };
  assert.throws(() => validateCiiCalibrationInputs(shortWindow, CII_EXPANDED_CAPTURE_TARGETS), /365-day/);
  assert.throws(() => validateCiiCalibrationInputs(raw, Object.keys(TIER1_COUNTRIES)), /37/);
});
