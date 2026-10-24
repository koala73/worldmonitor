// UCDP organised violence in the CII (v15, Stage B6): a continuous, decayed,
// per-capita term inside Conflict replaces the v8-v14 war/minor class floors,
// and the cache window is checked at read time (P9).
// See CII_UCDP_* in server/worldmonitor/intelligence/v1/_risk-config.ts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { assessCiiInputs } from '../api/_cii-input-health.js';
import { loadCiiFixtures } from '../scripts/lib/cii-fixtures.mts';
import {
  CII_HEALTH_INPUT_IDS,
  assessCiiInputWindows,
  assessUcdpWindow,
  buildCiiAuxiliarySources,
  parseUcdpCache,
  scoreCiiAuxiliarySources,
  ucdpViolenceRates,
  ucdpViolenceScore,
  withCiiInputQuietClocks,
  type AuxiliarySources,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import * as riskConfig from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';

const { summarizeUcdpWindow, ucdpLocatedCountry } = createRequire(import.meta.url)('../scripts/shared/ucdp-candidate.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 23, 9, 46);
const CODES = Object.keys(TIER1_COUNTRIES).sort();
const FIXTURES = loadCiiFixtures();

const parse = (inputs: object, nowMs: number) => buildCiiAuxiliarySources(inputs, nowMs, { iranEventsEnabled: true });
const table = (aux: AuxiliarySources, nowMs: number) => Object.fromEntries(scoreCiiAuxiliarySources(aux, { nowMs }).rows.map((r) => [r.region, r]));
const ucdpRow = (code: string, deathsBest: number, dateStart: number) => ({ country: TIER1_COUNTRIES[code], deathsBest, dateStart });

/** An empty build with live (empty) advisories, so no fallback level applies. */
function background(nowMs = NOW): AuxiliarySources {
  const aux = parse({}, nowMs);
  aux.advisories = { byCountry: {} };
  return aux;
}

describe('CII UCDP term: no step functions on event counts', () => {
  it('one more UCDP event (one death, yesterday) moves no country by more than 3 points on any fixture', () => {
    const jumps: string[] = [];
    for (const f of FIXTURES) {
      const aux = parse(f.inputs, f.nowMs);
      const before = table(aux, f.nowMs);
      const after = table({ ...aux, ucdpEvents: [...aux.ucdpEvents, ...CODES.map((code) => ucdpRow(code, 1, f.nowMs - DAY_MS))] }, f.nowMs);
      for (const code of CODES) {
        const delta = after[code]!.combinedScore - before[code]!.combinedScore;
        if (Math.abs(delta) > 3) jumps.push(`${code} ${delta > 0 ? '+' : ''}${delta} (${f.label})`);
      }
    }
    assert.deepEqual(jumps, [], `one UCDP event is a step: ${jumps.join(', ')}`);
  });

  it('no UCDP floor exists or binds', () => {
    for (const f of FIXTURES) {
      for (const row of Object.values(table(parse(f.inputs, f.nowMs), f.nowMs))) {
        assert.ok(!('ucdp' in row.floors), `${row.region} (${f.label}) still carries a UCDP floor of ${(row.floors as any).ucdp}`);
      }
    }
  });

  it('the same deaths per capita give the same Conflict component in every country (P2, P10)', () => {
    const aux = background();
    // Two deaths per million people a week ago, as one event.
    aux.ucdpEvents = CODES.map((code) => ucdpRow(code, 2 * riskConfig.CII_POPULATION_MILLIONS[code]!, NOW - 7 * DAY_MS));
    const t = table(aux, NOW);
    const conflicts = new Set(CODES.map((code) => t[code]!.components.conflict.toFixed(6)));
    assert.equal(conflicts.size, 1, `Conflict differs across countries for the same per-capita evidence: ${CODES.map((c) => `${c} ${t[c]!.components.conflict}`).join(', ')}`);
    assert.ok(Number([...conflicts][0]) > 0, 'per-capita evidence must reach Conflict');
  });
});

describe('CII UCDP term: shape', () => {
  const { CII_UCDP_CONFLICT_CAP: CAP, CII_UCDP_HALF_LIFE_DAYS: H, CII_UCDP_WINDOW_DAYS: W, CII_POPULATION_MILLIONS: POP } = riskConfig;

  it('has a population for every Tier-1 country', () => {
    assert.deepEqual(CODES.filter((code) => !(POP[code]! > 0)), []);
  });

  it('reads deaths per million people per year for a steady rate, whatever the half-life', () => {
    // 1 death a day for the whole window in a country of 1M people is 365 a year.
    const rows = Array.from({ length: W }, (_, i) => ({ country: 'Qatar', deathsBest: POP.QA!, dateStart: NOW - i * DAY_MS }));
    const rate = ucdpViolenceRates(rows, NOW).QA!;
    assert.ok(Math.abs(rate - 365) / 365 < 0.01, `steady 1/M/day should read ~365/M/yr, got ${rate}`);
  });

  it('places the World Bank conflict-intensity thresholds at half the cap and at the cap', () => {
    assert.ok(Math.abs(ucdpViolenceScore(10) - CAP / 2) < 1e-9, `10/M/yr (medium intensity) -> ${ucdpViolenceScore(10)}`);
    assert.equal(ucdpViolenceScore(100), CAP);
    assert.equal(ucdpViolenceScore(10_000), CAP);
    assert.equal(ucdpViolenceScore(0), 0);
  });

  it('halves an event\'s weight every half-life', () => {
    const at = (ageDays: number) => ucdpViolenceRates([{ country: 'Mexico', deathsBest: 100, dateStart: NOW - ageDays * DAY_MS }], NOW).MX!;
    assert.ok(Math.abs(at(H) / at(0) - 0.5) < 1e-9);
    assert.ok(Math.abs(at(2 * H) / at(0) - 0.25) < 1e-9);
    assert.equal(ucdpViolenceRates([{ country: 'Mexico', deathsBest: 100, dateStart: NOW - (W + 1) * DAY_MS }], NOW).MX, undefined);
  });

  it('counts a row with no best estimate as one death per event', () => {
    const one = ucdpViolenceRates([{ country: 'Brazil', deathsBest: 0, dateStart: NOW }], NOW).BR!;
    const day = ucdpViolenceRates([{ country: 'Brazil', deathsBest: 0, events: 3, dateStart: NOW }], NOW).BR!;
    assert.ok(one > 0);
    assert.ok(Math.abs(day / one - 3) < 1e-9);
  });

  it('is continuous: one more death never moves the term by more than a fraction of a point in a mid-size country', () => {
    let prev = 0;
    let worstStep = 0;
    for (let deaths = 1; deaths <= 2000; deaths++) {
      const term = ucdpViolenceScore(ucdpViolenceRates([{ country: 'Mexico', deathsBest: deaths, dateStart: NOW }], NOW).MX!);
      worstStep = Math.max(worstStep, term - prev);
      prev = term;
    }
    assert.ok(worstStep < 1, `largest Conflict step per death in Mexico ${worstStep}`);
  });

  it('scores the writers\' day aggregates exactly as the events they summarise', () => {
    const day = Math.floor((NOW - 10 * DAY_MS) / DAY_MS);
    const fromEvents = parseUcdpCache({ events: [
      { country: 'Mexico', deathsBest: 4, dateStart: day * DAY_MS },
      { country: 'Mexico', deathsBest: 0, dateStart: day * DAY_MS },
    ] });
    const fromDays = parseUcdpCache({ events: [], countryDays: { Mexico: [[day, 2, 5]] }, dailyTotals: [[day, 2]] });
    assert.equal(ucdpViolenceRates(fromEvents.rows, NOW).MX, ucdpViolenceRates(fromDays.rows, NOW).MX);
    assert.deepEqual(fromDays.dailyTotals, { [String(day)]: 2 });
    assert.equal(fromEvents.dailyTotals, null);
  });
});

describe('CII UCDP read-time window check (P9)', () => {
  /** n events a day across every country for `days` days ending `lagDays` before NOW. */
  function totals(days: number, lagDays: number, skip: (dayIndex: number) => boolean = () => false): Record<string, number> {
    const out: Record<string, number> = {};
    const last = Math.floor(NOW / DAY_MS) - lagDays;
    for (let d = last - days + 1; d <= last; d++) if (!skip(d)) out[String(d)] = 60;
    return out;
  }

  it('accepts a full year at UCDP\'s usual one-month lag', () => {
    const w = assessUcdpWindow([], totals(340, 23), NOW);
    assert.equal(w.honest, true, JSON.stringify(w));
    assert.deepEqual(w.gapMonths, []);
  });

  it('rejects the 2026-10 cache on every fixture: Jan-Aug 2026 missing', () => {
    for (const f of FIXTURES) {
      const aux = parse(f.inputs, f.nowMs);
      const w = assessUcdpWindow(aux.ucdpEvents, aux.ucdpDailyTotals, f.nowMs);
      assert.equal(w.honest, false);
      assert.deepEqual(w.gapMonths, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'], f.label);
    }
  });

  it('rejects a window the writers flagged incomplete, even when its rows look dense enough', () => {
    // A failed second page of one monthly release leaves ~1,000 of ~1,800 rows:
    // the month clears the density check, but the writers know it is short.
    const payload = { events: [], countryDays: { Mexico: [[Math.floor(NOW / DAY_MS) - 30, 2, 5]] }, dailyTotals: Object.entries(totals(340, 23)).map(([d, n]) => [Number(d), n]), window: { complete: false } };
    const parsed = parseUcdpCache(payload);
    assert.equal(parsed.writerComplete, false);
    const aux = parse({ ucdp: payload }, NOW);
    const w = assessCiiInputWindows(aux, NOW).ucdp!;
    assert.equal(w.writerComplete, false);
    assert.equal(w.honest, false, 'a writer-reported incomplete window must not read honest');
    const complete = parse({ ucdp: { ...payload, window: { complete: true } } }, NOW);
    assert.equal(assessCiiInputWindows(complete, NOW).ucdp!.honest, true);
  });

  it('a month listed as unpublished cannot exempt a hole inside the window', () => {
    // Only a release newer than the newest one with data can be unpublished; a
    // payload that names a mid-window month must still read short_window.
    const noApril = totals(340, 23, (d) => new Date(d * DAY_MS).toISOString().startsWith('2026-04'));
    const dailyTotals = Object.entries(noApril).map(([d, n]) => [Number(d), n]);
    const countryDays = { Mexico: [[Math.floor(NOW / DAY_MS) - 30, 2, 5]] };
    const forged = parse({ ucdp: { events: [], countryDays, dailyTotals, window: { complete: true, gapMonths: [], upstreamGapMonths: ['2026-04'] } } }, NOW);
    const w = assessCiiInputWindows(forged, NOW).ucdp!;
    assert.equal(w.honest, false);
    assert.deepEqual(w.gapMonths, ['2026-04']);
  });

  it('the unpublished frontier month is reported and does not fail the check', () => {
    const dailyTotals = Object.entries(totals(340, 23)).map(([d, n]) => [Number(d), n]);
    const countryDays = { Mexico: [[Math.floor(NOW / DAY_MS) - 30, 2, 5]] };
    const aux = parse({ ucdp: { events: [], countryDays, dailyTotals, window: { complete: true, gapMonths: [], upstreamGapMonths: ['2026-10'] } } }, NOW);
    const w = assessCiiInputWindows(aux, NOW).ucdp!;
    assert.equal(w.honest, true);
    assert.deepEqual(w.upstreamGapMonths, ['2026-10']);
  });

  it('rejects a missing month, a short span and a stale frontier', () => {
    const missingApril = totals(340, 23, (d) => new Date(d * DAY_MS).toISOString().startsWith('2026-04'));
    assert.deepEqual(assessUcdpWindow([], missingApril, NOW).gapMonths, ['2026-04']);
    assert.equal(assessUcdpWindow([], totals(200, 23), NOW).honest, false, 'reaches back 223 of 365 days');
    assert.equal(assessUcdpWindow([], totals(270, 95), NOW).honest, false, 'newest row 95 days old');
    assert.equal(assessUcdpWindow([], null, NOW).honest, false, 'no rows at all');
  });

  it('is reported in input health and graded short_window by the reader', () => {
    const f = FIXTURES.at(-1)!;
    const aux = parse(f.inputs, f.nowMs);
    const windows = assessCiiInputWindows(aux, f.nowMs);
    assert.equal(windows.ucdp?.honest, false);
    const states = Object.fromEntries(CII_HEALTH_INPUT_IDS.map((id) => [id, 'live'])) as any;
    const reports = withCiiInputQuietClocks(states, null, f.nowMs, windows);
    assert.deepEqual(reports.ucdp.window, windows.ucdp);
    const verdict = assessCiiInputs({ inputs: reports }, f.nowMs);
    assert.equal(verdict.states.ucdp, 'short_window');
    assert.ok(verdict.dead.some((d: any) => d.id === 'ucdp' && d.state === 'short_window' && d.window.gapMonths.length === 8));
    const honest = withCiiInputQuietClocks(states, null, f.nowMs, { ucdp: { ...windows.ucdp!, honest: true, gapMonths: [] } });
    assert.equal(assessCiiInputs({ inputs: honest }, f.nowMs).states.ucdp, 'live');
  });
});

describe('CII UCDP term: events score where they happen (owner ruling, 2026-10-23)', () => {
  // UCDP GED codes Gaza and West Bank events with country "Israel" (country_id
  // 666) and puts the territory in adm_1. The writers attribute by location, so
  // those events feed Palestine, which is not one of the 31 scored countries.
  //
  // KNOWN DIVERGENCE (Israel). The committed fixtures hold the pre-v15 events
  // payload, whose trimmed rows carry no adm_1 or coordinates, so replay still
  // counts Gaza and the West Bank toward Israel: IL scores 51 / 50 / 53 on the
  // three fixtures (UCDP 31 deaths per million a year, Conflict term 52). The
  // located payload the writers now publish gives Israel 2.9 per million a year
  // (term 19); on the 2026-10-23T0946Z inputs that is a score of 50, held by the
  // reconsider advisory floor. A located fixture must be captured after the
  // writers deploy and before v15 ships (brief section 3; cii-changes/v15.json
  // b6-ucdp.knownDivergence).
  const day = Math.floor((NOW - 10 * DAY_MS) / DAY_MS);
  const raw = (adm1: string, best: number) => ({ id: `${adm1}-${best}`, country: 'Israel', adm_1: adm1, date_start: new Date(day * DAY_MS).toISOString().slice(0, 10), best });
  const ratesFromRawRows = (rows: Array<ReturnType<typeof raw>>) => {
    const located = rows.map((e) => ({ country: ucdpLocatedCountry(e), dateStart: Date.parse(e.date_start), deathsBest: e.best }));
    const summary = summarizeUcdpWindow(located, { startMs: NOW - 365 * DAY_MS, endMs: NOW });
    return ucdpViolenceRates(parseUcdpCache({ events: [], ...summary }).rows, NOW);
  };

  it('a Gaza or West Bank event raises no Israeli term', () => {
    assert.equal(ucdpLocatedCountry(raw('Gaza Strip', 50)), 'Palestine');
    assert.equal(ucdpLocatedCountry(raw('West Bank', 5)), 'Palestine');
    assert.equal(ratesFromRawRows([raw('Gaza Strip', 50), raw('West Bank', 5)]).IL, undefined);
  });

  it('an event inside Israel raises the Israeli term', () => {
    assert.equal(ucdpLocatedCountry(raw('Southern district', 3)), 'Israel');
    assert.ok(ratesFromRawRows([raw('Southern district', 3)]).IL! > 0);
  });

  it("Israel's per-capita rate uses Israel's population only", () => {
    const { CII_POPULATION_MILLIONS: POP, CII_UCDP_HALF_LIFE_DAYS: H, CII_UCDP_WINDOW_DAYS: W } = riskConfig;
    assert.ok(Math.abs(POP.IL! - 9.65) < 0.01, `IL population ${POP.IL} must be Israel's own (UN WPP 2024: 9.65M)`);
    const kernelYears = (H / Math.LN2) * (1 - 0.5 ** (W / H)) / 365;
    const rate = ucdpViolenceRates([{ country: 'Israel', deathsBest: 100, dateStart: NOW }], NOW).IL!;
    assert.ok(Math.abs(rate - 100 / (kernelYears * 9.65)) < 1e-6, `rate ${rate}`);
  });
});

describe('CII UCDP term: one violence family, merged by max (P6)', () => {
  // UCDP deaths and GDELT CAMEO 18-20 coverage report the same war: within the
  // violence family sources merge by max, never by sum (brief, P6).
  it('UCDP and GDELT conflict take the larger, not the sum', () => {
    const aux = background();
    const week = { articles: 3000, conflict: 900, protest: 60 }; // GDELT conflict level 70 * (0.3 - 0.14) / 0.26 = 43
    aux.gdeltCountryEvents = { byCountry: { MX: { conflict: null, protest: null, week, strikes: null } }, strikeDays: null };
    aux.ucdpEvents = [ucdpRow('MX', 10 * riskConfig.CII_POPULATION_MILLIONS.MX!, NOW - DAY_MS)];
    const t = table(aux, NOW).MX!;
    const gdelt = t.parts.gdeltConflict;
    const ucdp = t.parts.ucdpViolence;
    assert.ok(gdelt > 0 && ucdp > 0, `both sources fire (GDELT ${gdelt}, UCDP ${ucdp})`);
    assert.ok(Math.abs(t.components.conflict - Math.max(gdelt, ucdp)) < 1e-9, `Conflict ${t.components.conflict} must be max(${gdelt}, ${ucdp}), not their sum`);
  });

  it('OREF still adds on top of the family max', () => {
    const aux = background();
    aux.orefData = { activeAlertCount: 1, historyCount24h: 0 };
    aux.ucdpEvents = [ucdpRow('IL', 50, NOW - DAY_MS)];
    const t = table(aux, NOW).IL!;
    assert.ok(Math.abs(t.components.conflict - Math.min(100, t.parts.ucdpViolence + t.parts.orefBoost)) < 1e-9);
  });
});
