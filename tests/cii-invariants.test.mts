// CII invariant suite: the required properties P1–P16 of
// docs/methodology/cii-change-brief.md, measured with the scoring seam on the
// committed production fixtures (tests/fixtures/cii/) and on synthetic
// scenarios. Thresholds come from the brief and must not be loosened to make
// a formula pass.
//
// A property the current formula fails is listed in KNOWN_GAPS and runs as a
// node:test `todo`: it still executes, its name carries the measured value,
// and it cannot fail CI. Every other property is a real assertion. When a
// formula change makes a known gap pass, the ratchet test fails until the
// property is removed from KNOWN_GAPS, so a fix is promoted, never silent.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import iso3ToIso2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import { loadCiiFixtures, pairsOrderedAgainstBlend, type CiiFixture } from '../scripts/lib/cii-fixtures.mts';
import {
  assessCiiInputAvailability,
  buildCiiAuxiliarySources,
  scoreCiiAuxiliarySources,
  type AuxiliarySources,
  type CiiScoreTableRow,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';

/**
 * Properties the formula named by CII_FORMULA_VERSION is known to fail. Shrink
 * it; never grow it to pass CI. A new formula version starts with no entry,
 * so every property asserts until its PR lists, with measured values, the
 * gaps it still has.
 */
const KNOWN_GAPS: Record<string, ReadonlySet<string>> = {
  v14: new Set([
    'P1', 'P2', 'P3a', 'P3b', 'P3c', 'P4', 'P5a', 'P5c', 'P7a', 'P7b', 'P8', 'P9', 'P10',
    'P11a', 'P12a', 'P12b', 'P14', 'P15b', 'P15e',
  ]),
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIXTURES = loadCiiFixtures();
const CODES = Object.keys(TIER1_COUNTRIES).sort();
/** Tier-1 OECD members that are stable democracies: the "quiet week", "riots" and "strike campaign on a strong state" anchors. */
const STABLE_OECD = ['DE', 'FR', 'GB', 'JP', 'KR', 'PL', 'US'];
const ISO2_TO_ISO3 = Object.fromEntries(Object.entries(iso3ToIso2 as Record<string, string>).map(([iso3, iso2]) => [iso2, iso3]));

type Table = Record<string, CiiScoreTableRow>;
interface Measurement { pass: boolean; value: string }

const clone = <T,>(value: T): T => structuredClone(value);
const r1 = (n: number) => Math.round(n * 10) / 10;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parse = (f: CiiFixture) => buildCiiAuxiliarySources(f.inputs, f.nowMs, { iranEventsEnabled: f.iranEventsEnabled });
function score(aux: AuxiliarySources, nowMs: number): Table {
  return Object.fromEntries(scoreCiiAuxiliarySources(aux, { nowMs }).rows.map((row) => [row.region, row]));
}
const S = (table: Table, code: string) => table[code]!.combinedScore;
const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const logit = (s: number) => { const p = Math.min(0.99, Math.max(0.01, s / 100)); return Math.log(p / (1 - p)); };
const worst = <T,>(items: T[], key: (t: T) => number, n = 3) => [...items].sort((a, b) => key(b) - key(a)).slice(0, n);

// ------------------------------------------------------------------------
// Evidence injection on parsed sources. Injecting after parsing tests the
// formula, not the parsers. Each helper adds the same evidence to every
// listed country in one build: v14 has no cross-country coupling in these
// inputs, so one build measures 31 independent responses.
// ------------------------------------------------------------------------

/** `units[i]` weighted confirmed strikes on the UTC day i days before `nowMs`. */
function addStrikes(aux: AuxiliarySources, codes: string[], nowMs: number, units: number[]): void {
  aux.confirmedStrikes = aux.confirmedStrikes ?? {};
  for (const code of codes) {
    const days = (aux.confirmedStrikes[code] ??= {});
    units.forEach((u, i) => { if (u > 0) days[utcDay(nowMs - i * DAY_MS)] = (days[utcDay(nowMs - i * DAY_MS)] ?? 0) + u; });
  }
}
function addUcdpEvents(aux: AuxiliarySources, codes: string[], nowMs: number, count: number, deaths: number, spanDays: number): void {
  aux.ucdpEvents = [...aux.ucdpEvents];
  for (const code of codes) {
    for (let i = 0; i < count; i++) {
      aux.ucdpEvents.push({ country: TIER1_COUNTRIES[code as keyof typeof TIER1_COUNTRIES], deathsBest: deaths, dateStart: nowMs - DAY_MS - (i / count) * spanDays * DAY_MS });
    }
  }
}
function addHeadlines(aux: AuxiliarySources, codes: string[], counts: Partial<Record<'critical' | 'high' | 'medium', number>>): void {
  const summary = { ...(aux.threatSummaryByCountry ?? {}) };
  for (const code of codes) {
    const row = { critical: 0, high: 0, medium: 0, low: 0, info: 0, ...(summary[code] ?? {}) };
    for (const [level, n] of Object.entries(counts)) row[level as 'critical'] += n ?? 0;
    summary[code] = row;
  }
  aux.threatSummaryByCountry = summary;
}
function setGdelt(aux: AuxiliarySources, codes: string[], row: { conflict?: [number, number]; protest?: [number, number]; week?: [number, number, number] }): void {
  const events = aux.gdeltCountryEvents ?? { byCountry: {}, strikeDays: null };
  const byCountry = { ...events.byCountry };
  for (const code of codes) {
    byCountry[code] = {
      conflict: row.conflict ? { current: row.conflict[0], baselineMedian: row.conflict[1] } : null,
      protest: row.protest ? { current: row.protest[0], baselineMedian: row.protest[1] } : null,
      week: row.week ? { articles: row.week[0], conflict: row.week[1], protest: row.week[2] } : null,
      strikes: null,
    };
  }
  aux.gdeltCountryEvents = { ...events, byCountry };
}

/** An all-empty build with live (empty) advisories, so no fallback level applies: the background for anchors. */
function emptyBackground(nowMs: number): AuxiliarySources {
  const aux = buildCiiAuxiliarySources({}, nowMs, { iranEventsEnabled: true });
  aux.advisories = { byCountry: {} };
  return aux;
}

// ------------------------------------------------------------------------
// Measurements. Each runs once at load so test names can carry the value.
// ------------------------------------------------------------------------

const channels: Record<string, (aux: AuxiliarySources, nowMs: number) => void> = {
  // +5 weighted strike units today.
  strikes: (aux, nowMs) => addStrikes(aux, CODES, nowMs, [5]),
  // +1 severe violent event: one UCDP event yesterday with 25 deaths.
  violence: (aux, nowMs) => addUcdpEvents(aux, CODES, nowMs, 1, 25, 0),
  // +1 severe unrest event: a nationwide internet shutdown.
  unrest: (aux) => { aux.outages = [...aux.outages, ...CODES.map((code) => ({ countryCode: code, severity: 'OUTAGE_SEVERITY_TOTAL' }))]; },
  // +10 on the information channel: ten more high-threat headlines.
  information: (aux) => addHeadlines(aux, CODES, { high: 10 }),
};

function measureP1(): Measurement {
  const dead: string[] = [];
  let total = 0;
  for (const f of FIXTURES) {
    const aux = parse(f);
    const base = score(aux, f.nowMs);
    for (const [channel, inject] of Object.entries(channels)) {
      const next = clone(aux);
      inject(next, f.nowMs);
      const moved = score(next, f.nowMs);
      for (const code of CODES) {
        if (S(base, code) >= 95) continue;
        total++;
        if (S(moved, code) - S(base, code) < 0.5) dead.push(`${code}/${channel}`);
      }
    }
  }
  const zero = [...new Set(dead)].slice(0, 6).join(', ');
  return { pass: dead.length === 0, value: `${dead.length}/${total} (country, channel, date) cases move < 0.5, e.g. ${zero}` };
}

function strikeResponses(units: number[]): Array<{ code: string; label: string; before: number; after: number }> {
  const out: Array<{ code: string; label: string; before: number; after: number }> = [];
  for (const f of FIXTURES) {
    const aux = parse(f);
    const base = score(aux, f.nowMs);
    const next = clone(aux);
    addStrikes(next, CODES, f.nowMs, units);
    const moved = score(next, f.nowMs);
    for (const code of CODES) out.push({ code, label: f.label, before: S(base, code), after: S(moved, code) });
  }
  return out;
}

function measureP2(): Measurement {
  const dz = strikeResponses([5]).filter((r) => r.before < 95).map((r) => ({ ...r, dz: logit(r.after) - logit(r.before) }));
  const lo = worst(dz, (r) => -r.dz, 1)[0]!;
  const hi = worst(dz, (r) => r.dz, 1)[0]!;
  const range = hi.dz - lo.dz;
  return {
    pass: range <= 0.25,
    value: `+5 strike units: Δz ranges ${range.toFixed(2)} (k = 0.25), ${hi.code} ${hi.before}→${hi.after} vs ${lo.code} ${lo.before}→${lo.after}`,
  };
}

function measureP3a(): Measurement {
  let maxStep = { step: 0, code: '', units: 0 };
  for (const f of FIXTURES) {
    const aux = parse(f);
    let prev = score(aux, f.nowMs);
    for (let u = 1; u <= 30; u++) {
      const next = clone(aux);
      addStrikes(next, CODES, f.nowMs, [u]);
      const table = score(next, f.nowMs);
      for (const code of CODES) {
        const step = S(table, code) - S(prev, code);
        if (step > maxStep.step) maxStep = { step, code, units: u };
      }
      prev = table;
    }
  }
  return { pass: maxStep.step <= 3, value: `largest step per strike unit ${maxStep.step} (${maxStep.code} at unit ${maxStep.units}); limit 3, no step > 5` };
}

/** 5 units/day for 3 days, then nothing: the score every 3 h for 8 days, with and without the campaign. Small enough that strike pressure falls through every v14 threshold inside the window. */
const recovery = (() => {
  const out: Array<{ code: string; label: string; maxDrop: number; halfLifeDays: number | null; c0: number }> = [];
  for (const f of FIXTURES) {
    const aux = parse(f);
    const struck = clone(aux);
    addStrikes(struck, CODES, f.nowMs, [5, 5, 5]);
    const series = Array.from({ length: 65 }, (_, k) => {
      const nowMs = f.nowMs + k * 3 * HOUR_MS;
      return { k, with: score(struck, nowMs), without: score(aux, nowMs) };
    });
    for (const code of CODES) {
      let maxDrop = 0;
      for (let k = 1; k < series.length; k++) maxDrop = Math.max(maxDrop, S(series[k - 1]!.with, code) - S(series[k]!.with, code));
      const c0 = S(series[0]!.with, code) - S(series[0]!.without, code);
      const half = series.find((p) => S(p.with, code) - S(p.without, code) <= c0 / 2);
      out.push({ code, label: f.label, maxDrop, c0, halfLifeDays: c0 >= 1 && half ? (half.k * 3) / 24 : null });
    }
  }
  return out;
})();

function measureP3b(): Measurement {
  const w = worst(recovery, (r) => r.maxDrop, 1)[0]!;
  return { pass: w.maxDrop <= 5, value: `largest 3-hour drop after a campaign ends ${w.maxDrop} (${w.code}); limit 5` };
}

function measureP3c(): Measurement {
  const measured = recovery.filter((r) => r.halfLifeDays != null).map((r) => r.halfLifeDays!);
  const silent = recovery.filter((r) => r.c0 < 1).length;
  const lo = measured.length ? Math.min(...measured) : NaN;
  const hi = measured.length ? Math.max(...measured) : NaN;
  return {
    pass: silent === 0 && lo >= 4 && hi <= 6,
    value: `campaign contribution halves in ${r1(lo)}–${r1(hi)} days (want 4–6); ${silent}/${recovery.length} cases show < 1 point of contribution`,
  };
}

function measureP4(): Measurement {
  const two = strikeResponses([5, 5]).filter((r) => r.before < 95);
  const seven = strikeResponses([5, 5, 5, 5, 5, 5, 5]).filter((r) => r.before < 95);
  const min2 = worst(two, (r) => -(r.after - r.before), 1)[0]!;
  const min7 = worst(seven, (r) => -(r.after - r.before), 1)[0]!;
  const fail2 = two.filter((r) => r.after - r.before < 5).length;
  const fail7 = seven.filter((r) => r.after - r.before < 10).length;
  return {
    pass: fail2 === 0 && fail7 === 0,
    value: `5 units/day: min +${min2.after - min2.before} at 48 h (${min2.code}; ${fail2}/${two.length} < +5), min +${min7.after - min7.before} at 7 d (${min7.code}; ${fail7}/${seven.length} < +10)`,
  };
}

const fixtureTables = FIXTURES.map((f) => ({ f, table: score(parse(f), f.nowMs) }));

function measureP5a(): Measurement {
  const worstTie = worst(fixtureTables.map(({ f, table }) => {
    const groups = new Map<number, string[]>();
    for (const row of Object.values(table)) {
      const key = Math.round(row.combinedScore * 10);
      groups.set(key, [...(groups.get(key) ?? []), row.region]);
    }
    const biggest = worst([...groups.entries()], ([, g]) => g.length, 1)[0]!;
    return { label: f.label, score: biggest[0] / 10, codes: biggest[1] };
  }), (t) => t.codes.length, 1)[0]!;
  return { pass: worstTie.codes.length <= 2, value: `${worstTie.codes.length} countries share ${worstTie.score} (${worstTie.label}); limit 2` };
}

function measureP5b(): Measurement {
  let w = { share: 0, from: 0, label: '' };
  for (const { f, table } of fixtureTables) {
    const scores = Object.values(table).map((r) => r.combinedScore);
    for (const from of scores) {
      const n = scores.filter((s) => s >= from && s < from + 5).length;
      if (n / scores.length > w.share) w = { share: n / scores.length, from, label: f.label };
    }
  }
  return { pass: w.share <= 0.25, value: `${Math.round(w.share * 100)}% of countries in [${w.from}, ${w.from + 5}) (${w.label}); limit 25%` };
}

function measureP5c(): Measurement {
  const counts = fixtureTables.map(({ f, table }) => ({ label: f.label, n: pairsOrderedAgainstBlend(Object.values(table)).length }));
  const w = worst(counts, (c) => c.n, 1)[0]!;
  return { pass: counts.every((c) => c.n === 0), value: `${counts.map((c) => c.n).join(' / ')} pairs ordered against the blend across fixtures (max ${w.n}, ${w.label}); limit 0` };
}

/**
 * Nulls each input in turn. Every country whose terms change must report a
 * coverage below 1 and below its coverage with the input present; a field
 * that exists but never falls does not pass.
 */
function measureP7a(): Measurement {
  const coverage = (row: CiiScoreTableRow) => (row as unknown as { coverage?: unknown }).coverage;
  let affected = 0;
  const silent: string[] = [];
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    for (const [input, failed] of Object.entries(FAILED_INPUT)) {
      const next = score({ ...aux, ...failed }, f.nowMs);
      for (const code of CODES) {
        const { combinedScore: _a, ...before } = table[code]!;
        const { combinedScore: _b, ...after } = next[code]!;
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        affected++;
        const was = coverage(table[code]!);
        const now = coverage(next[code]!);
        if (!(typeof now === 'number' && now < 1 && typeof was === 'number' && now < was)) silent.push(`${code}/${input}`);
      }
    }
  }
  const emitted = typeof coverage(Object.values(fixtureTables[0]!.table)[0]!) === 'number';
  return {
    pass: affected > 0 && silent.length === 0,
    value: emitted
      ? `${silent.length}/${affected} (country, nulled input) cases keep their coverage, e.g. ${silent.slice(0, 4).join(', ')}`
      : `no coverage output: in ${affected} (country, nulled input) cases a missing input reads as calm`,
  };
}

function measureP7b(): Measurement {
  const cases = FIXTURES.map((f) => {
    const aux = parse(f);
    const records = aux.outages.length;
    const mapped = aux.outages.filter((o: any) => CODES.includes(String(o.countryCode || o.country_code || '').toUpperCase())).length;
    const state = assessCiiInputAvailability([], aux, f.nowMs, false).outages;
    return { label: f.label, records, mapped, state };
  });
  const bad = cases.filter((c) => c.records > 0 && c.mapped === 0 && c.state !== 'unusable');
  const c = bad[0] ?? cases[0]!;
  return { pass: bad.length === 0, value: `outages: ${c.mapped} of ${c.records} records map to a country, health reads ${c.state} (want unusable)` };
}

const FAILED_INPUT: Record<string, Partial<AuxiliarySources>> = {
  ucdp: { ucdpEvents: [] }, outages: { outages: [] }, climate: { climate: [] }, fires: { fires: null },
  gpsjam: { gpsHexes: [] }, iranEvents: { iranEvents: [] }, oref: { orefData: null }, advisories: { advisories: null },
  displacement: { displacedByIso3: {} }, crossBorder: { crossBorderSurgeCountries: [] }, newsInsights: { newsTopStories: [] },
  threatSummary: { threatSummaryByCountry: null }, aviation: { aviationAlerts: [] }, earthquakes: { earthquakes: [] },
  sanctions: { sanctionsCountries: [], sanctionsCountryCounts: null }, militaryCii: { militaryCii: null },
  gdeltCountryEvents: { gdeltCountryEvents: null }, strikePressure: { confirmedStrikes: null },
};

function measureP8(): Measurement {
  const moves: Array<{ input: string; code: string; label: string; delta: number }> = [];
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    for (const [input, failed] of Object.entries(FAILED_INPUT)) {
      const next = score({ ...aux, ...failed }, f.nowMs);
      for (const code of CODES) moves.push({ input, code, label: f.label, delta: S(next, code) - S(table, code) });
    }
  }
  const top = worst(moves, (m) => Math.abs(m.delta), 3);
  return {
    pass: top.every((m) => Math.abs(m.delta) <= 10),
    value: `one failed input moves a country by up to ${top.map((m) => `${m.code} ${m.delta > 0 ? '+' : ''}${m.delta} (${m.input})`).join(', ')}; limit K = 10; no provenance-flip alarm exists`,
  };
}

function measureP9(): Measurement {
  const WINDOW_DAYS = 730;
  const cases = FIXTURES.map((f) => {
    const dates = parse(f).ucdpEvents.map((e: any) => Number(e.dateStart)).filter((d) => Number.isFinite(d) && d <= f.nowMs && f.nowMs - d < WINDOW_DAYS * DAY_MS);
    const spanDays = dates.length ? (f.nowMs - Math.min(...dates)) / DAY_MS : 0;
    const recent = dates.filter((d) => f.nowMs - d < 60 * DAY_MS).length / Math.max(1, dates.length);
    return { label: f.label, spanDays, recent, newestDays: dates.length ? (f.nowMs - Math.max(...dates)) / DAY_MS : NaN };
  });
  const c = worst(cases, (x) => -x.spanDays, 1)[0]!;
  return {
    pass: cases.every((x) => x.spanDays >= 0.9 * WINDOW_DAYS),
    value: `UCDP cache spans ${Math.round(c.spanDays)} of the ${WINDOW_DAYS} days its thresholds assume, ${Math.round(c.recent * 100)}% of rows in the last 60 days, newest ${Math.round(c.newestDays)} days old`,
  };
}

function measureP10(): Measurement {
  const moves: Array<{ code: string; delta: number }> = [];
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    // Ten more airports reporting moderate delays: infrastructure density, not instability.
    const next = { ...aux, aviationAlerts: [...aux.aviationAlerts, ...CODES.flatMap((code) => Array.from({ length: 10 }, () => ({ country: TIER1_COUNTRIES[code as keyof typeof TIER1_COUNTRIES], severity: 'moderate', delayType: 'general' })))] };
    const moved = score(next, f.nowMs);
    for (const code of CODES) moves.push({ code, delta: S(moved, code) - S(table, code) });
  }
  const w = worst(moves, (m) => m.delta, 1)[0]!;
  return { pass: w.delta <= 0, value: `10 more delayed airports raise ${moves.filter((m) => m.delta > 0).length}/${moves.length} cases, up to +${w.delta} (${w.code})` };
}

function measureP11a(): Measurement {
  const moves: Array<{ code: string; delta: number }> = [];
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    // A critical headline reporting country A striking a non-Tier-1 target names both.
    const next = { ...aux, newsTopStories: [...aux.newsTopStories, ...CODES.map((code) => ({ countryCode: code, countryCodes: [code, 'SO'], threatLevel: 'critical', primaryTitle: '' }))] };
    const moved = score(next, f.nowMs);
    for (const code of CODES) moves.push({ code, delta: S(moved, code) - S(table, code) });
  }
  const w = worst(moves, (m) => m.delta, 1)[0]!;
  return { pass: moves.every((m) => m.delta === 0), value: `a headline on A's strike abroad raises A in ${moves.filter((m) => m.delta !== 0).length}/${moves.length} cases, up to +${w.delta} (${w.code})` };
}

function measureP11b(): Measurement {
  const moves: number[] = [];
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    const militaryCii = { ...(aux.militaryCii ?? {}) };
    for (const code of CODES) militaryCii[code] = { ...(militaryCii[code] ?? {}), ownFlights: Number(militaryCii[code]?.ownFlights ?? 0) + 50, ownVessels: Number(militaryCii[code]?.ownVessels ?? 0) + 20 };
    const moved = score({ ...aux, militaryCii }, f.nowMs);
    for (const code of CODES) moves.push(S(moved, code) - S(table, code));
  }
  const maxMove = Math.max(...moves.map(Math.abs));
  return { pass: maxMove === 0, value: `+50 own military flights and +20 own vessels move a country by at most ${maxMove}` };
}

/** Deterministic PRNG so the noise test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * ±10% on every magnitude, including the scored numbers inside list records
 * (UCDP deaths, quake magnitude, fire brightness and radiative power, numeric
 * climate severity); dates and locations stay fixed. Each list record is also
 * dropped or duplicated with probability 5% each.
 */
function perturb(aux: AuxiliarySources, rand: () => number): AuxiliarySources {
  const jitter = (n: number) => n * (0.9 + 0.2 * rand());
  const resample = <T,>(rows: T[]) => rows.flatMap((row) => { const u = rand(); return u < 0.05 ? [] : u < 0.1 ? [row, row] : [row]; });
  const mapValues = <T,>(o: Record<string, T> | null | undefined, fn: (v: T) => T) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)])) : o);
  const jitterFields = (row: any, fields: string[]) => {
    const out = { ...row };
    for (const field of fields) if (typeof out[field] === 'number') out[field] = jitter(out[field]);
    return out;
  };
  const next = clone(aux);
  for (const field of ['ucdpEvents', 'outages', 'climate', 'gpsHexes', 'iranEvents', 'aviationAlerts', 'earthquakes', 'newsTopStories'] as const) {
    (next as any)[field] = resample((next as any)[field] ?? []);
  }
  next.ucdpEvents = next.ucdpEvents.map((e) => jitterFields(e, ['deathsBest']));
  next.earthquakes = next.earthquakes.map((e) => jitterFields(e, ['magnitude']));
  next.climate = next.climate.map((a) => jitterFields(a, ['severity', 'score']));
  next.fires = mapValues(next.fires, (rows) => resample(rows).map((f) => jitterFields(f, ['brightness', 'frp'])));
  next.displacedByIso3 = mapValues(next.displacedByIso3, jitter) ?? {};
  next.threatSummaryByCountry = mapValues(next.threatSummaryByCountry, (row) => mapValues(row as any, jitter) as any);
  next.sanctionsCountryCounts = mapValues(next.sanctionsCountryCounts, jitter);
  next.sanctionsCountries = next.sanctionsCountries.map((c: any) => ({ ...c, entryCount: jitter(Number(c.entryCount) || 0) }));
  next.militaryCii = mapValues(next.militaryCii, (m: any) => mapValues(m, (v: any) => (typeof v === 'number' ? jitter(v) : v)));
  next.confirmedStrikes = mapValues(next.confirmedStrikes, (days) => mapValues(days, jitter) as any);
  if (next.orefData) next.orefData = { activeAlertCount: Math.round(jitter(next.orefData.activeAlertCount)), historyCount24h: Math.round(jitter(next.orefData.historyCount24h)) };
  if (next.gdeltCountryEvents) {
    next.gdeltCountryEvents.byCountry = mapValues(next.gdeltCountryEvents.byCountry, (row) => {
      const articles = row.week ? jitter(row.week.articles) : 0;
      return {
        conflict: row.conflict && { current: jitter(row.conflict.current), baselineMedian: row.conflict.baselineMedian == null ? null : jitter(row.conflict.baselineMedian) },
        protest: row.protest && { current: jitter(row.protest.current), baselineMedian: row.protest.baselineMedian == null ? null : jitter(row.protest.baselineMedian) },
        week: row.week && { articles, conflict: Math.min(articles, jitter(row.week.conflict)), protest: Math.min(articles, jitter(row.week.protest)) },
        strikes: row.strikes && mapValues(row.strikes, ([s, a]) => { const arts = jitter(a); return [Math.min(arts, jitter(s)), arts] as [number, number]; }),
      };
    }) ?? {};
  }
  return next;
}

function measureP12a(): Measurement {
  const deltas: number[] = [];
  const rand = mulberry32(20261023);
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    for (let draw = 0; draw < 40; draw++) {
      const noisy = score(perturb(aux, rand), f.nowMs);
      for (const code of CODES) deltas.push(Math.abs(S(noisy, code) - S(table, code)));
    }
  }
  const median = quantile(deltas, 0.5);
  const p99 = quantile(deltas, 0.99);
  return { pass: median <= 2 && p99 <= 6, value: `±10% input noise: median |ΔS| ${median}, p99 ${p99}, max ${Math.max(...deltas)} over ${deltas.length} country-draws; limits 2 / 6` };
}

function measureP12b(): Measurement {
  let w = { delta: 0, code: '', k: 1 };
  for (const { f, table } of fixtureTables) {
    const aux = parse(f);
    for (const k of [0.5, 2, 4]) {
      const next = clone(aux);
      // Article volume ×k with every share unchanged: GDELT coverage and classified headline counts.
      if (next.gdeltCountryEvents) {
        for (const row of Object.values(next.gdeltCountryEvents.byCountry)) {
          if (row.week) row.week = { articles: row.week.articles * k, conflict: row.week.conflict * k, protest: row.week.protest * k };
          for (const signal of [row.conflict, row.protest]) {
            if (signal) { signal.current *= k; if (signal.baselineMedian != null) signal.baselineMedian *= k; }
          }
          if (row.strikes) row.strikes = Object.fromEntries(Object.entries(row.strikes).map(([d, [s, a]]) => [d, [s * k, a * k]]));
        }
      }
      if (next.threatSummaryByCountry) {
        for (const row of Object.values(next.threatSummaryByCountry)) for (const level of Object.keys(row)) (row as any)[level] *= k;
      }
      const moved = score(next, f.nowMs);
      for (const code of CODES) {
        const delta = Math.abs(S(moved, code) - S(table, code));
        if (delta > w.delta) w = { delta, code, k };
      }
    }
  }
  return { pass: w.delta <= 1, value: `article volume ×0.5–4 with shares fixed moves a country by up to ${w.delta} (${w.code} at ×${w.k}); limit 1` };
}

function measureP14(): Measurement {
  const gaps = fixtureTables.flatMap(({ f, table }) => Object.values(table).map((r) => ({ code: r.region, label: f.label, gap: Math.abs(r.combinedScore - r.blended) })));
  const w = worst(gaps, (g) => g.gap, 1)[0]!;
  return {
    pass: w.gap <= 0.5,
    value: `final − (prior + Σ terms) up to ${r1(w.gap)} (${w.code}, ${w.label}): floors and the cap are not additive terms; the API emits 4 of 30 terms`,
  };
}

const SCENARIO_NOW = FIXTURES.at(-1)?.nowMs ?? Date.UTC(2026, 9, 23);
const anchors: Record<string, { title: string; band: [number, number]; codes: string[]; build: (aux: AuxiliarySources, codes: string[]) => void }> = {
  P15a: {
    title: 'quiet OECD week ≤ 15', band: [0, 15], codes: STABLE_OECD,
    build: () => {},
  },
  P15b: {
    title: 'nationwide riots in a stable democracy 35–55', band: [35, 55], codes: STABLE_OECD,
    build: (aux, codes) => {
      setGdelt(aux, codes, { protest: [300, 100], week: [2000, 100, 160] });
      addHeadlines(aux, codes, { high: 10, medium: 20 });
      aux.newsTopStories = [...aux.newsTopStories, ...codes.flatMap((code) => [1, 2, 3].map(() => ({ countryCode: code, countryCodes: [code], threatLevel: 'high', primaryTitle: '' })))];
    },
  },
  P15c: {
    title: 'strike campaign on a strong state 45–65', band: [45, 65], codes: STABLE_OECD,
    build: (aux, codes) => {
      addStrikes(aux, codes, SCENARIO_NOW, Array.from({ length: 10 }, () => 8));
      setGdelt(aux, codes, { conflict: [200, 100], week: [2000, 400, 20] });
      addHeadlines(aux, codes, { critical: 3, high: 10 });
    },
  },
  P15d: {
    title: 'chronic civil war ≥ 70', band: [70, 100], codes: CODES,
    build: (aux, codes) => {
      addUcdpEvents(aux, codes, SCENARIO_NOW, 150, 10, 700);
      setGdelt(aux, codes, { conflict: [300, 300], week: [3000, 900, 60] });
      addHeadlines(aux, codes, { high: 5, medium: 10 });
      aux.advisories = { byCountry: Object.fromEntries(codes.map((code) => [code, 'do-not-travel' as const])) };
      aux.displacedByIso3 = Object.fromEntries(codes.map((code) => [ISO2_TO_ISO3[code]!, 3_000_000]));
    },
  },
  P15e: {
    title: 'full-scale war ≥ 85', band: [85, 100], codes: CODES,
    build: (aux, codes) => {
      addUcdpEvents(aux, codes, SCENARIO_NOW, 400, 50, 180);
      addStrikes(aux, codes, SCENARIO_NOW, Array.from({ length: 14 }, () => 20));
      setGdelt(aux, codes, { conflict: [1500, 300], week: [5000, 2000, 100] });
      addHeadlines(aux, codes, { critical: 20, high: 30 });
      aux.newsTopStories = [...aux.newsTopStories, ...codes.flatMap((code) => [1, 2, 3, 4, 5].map(() => ({ countryCode: code, countryCodes: [code], threatLevel: 'critical', primaryTitle: '' })))];
      aux.advisories = { byCountry: Object.fromEntries(codes.map((code) => [code, 'do-not-travel' as const])) };
      aux.displacedByIso3 = Object.fromEntries(codes.map((code) => [ISO2_TO_ISO3[code]!, 6_000_000]));
    },
  },
};

function measureAnchor(id: string): Measurement {
  const anchor = anchors[id]!;
  const aux = emptyBackground(SCENARIO_NOW);
  anchor.build(aux, anchor.codes);
  const table = score(aux, SCENARIO_NOW);
  const scored = anchor.codes.map((code) => ({ code, s: S(table, code) }));
  const lo = worst(scored, (x) => -x.s, 1)[0]!;
  const hi = worst(scored, (x) => x.s, 1)[0]!;
  const out = scored.filter((x) => x.s < anchor.band[0] || x.s > anchor.band[1]).length;
  return { pass: out === 0, value: `${lo.s}–${hi.s} (${lo.code}–${hi.code}), ${out}/${scored.length} outside ${anchor.band[0]}–${anchor.band[1]}` };
}

const PROPERTIES: Array<{ id: string; title: string; measure: () => Measurement }> = [
  { id: 'P1', title: 'responds to evidence: +5 strike units, +1 severe event or +10 on a channel raises S by ≥ 0.5', measure: measureP1 },
  { id: 'P2', title: 'parity: the same evidence gives the same Δz in every country', measure: measureP2 },
  { id: 'P3a', title: 'continuity: ≤ 3 points per strike unit, no step > 5', measure: measureP3a },
  { id: 'P3b', title: 'continuity: recovery has no cliffs', measure: measureP3b },
  { id: 'P3c', title: 'continuity: a 5-day half-life ± 20%', measure: measureP3c },
  { id: 'P4', title: 'responsiveness: 5 units/day gives ≥ +5 in 48 h and ≥ +10 in 7 d in every country', measure: measureP4 },
  { id: 'P5a', title: 'preserves information: ≤ 2 countries share a score', measure: measureP5a },
  { id: 'P5b', title: 'preserves information: no 5-point band holds > 25% of countries', measure: measureP5b },
  { id: 'P5c', title: 'preserves information: 0 pairs ordered against the evidence', measure: measureP5c },
  { id: 'P7a', title: 'unknown ≠ calm: a nulled input sets coverage < 1', measure: measureP7a },
  { id: 'P7b', title: 'unknown ≠ calm: a reader mapping 0 of N records is unusable, not quiet', measure: measureP7b },
  { id: 'P8', title: 'robust to a failed input: no country moves by > 10', measure: measureP8 },
  { id: 'P9', title: 'window honesty: the cached window equals the calibrated window', measure: measureP9 },
  { id: 'P10', title: 'normalisation: more infrastructure never raises S', measure: measureP10 },
  { id: 'P11a', title: "exclusion: A's strikes on B leave A unchanged", measure: measureP11a },
  { id: 'P11b', title: "exclusion: A's forces abroad leave A unchanged", measure: measureP11b },
  { id: 'P12a', title: 'noise: ±10% on every input gives median |ΔS| ≤ 2, p99 ≤ 6', measure: measureP12a },
  { id: 'P12b', title: 'noise: article volume ×0.5–4 with shares fixed moves S ≤ 1', measure: measureP12b },
  { id: 'P14', title: 'explainable: prior + Σ term deltas = S within 0.5', measure: measureP14 },
  ...Object.entries(anchors).map(([id, anchor]) => ({ id, title: `anchor: ${anchor.title}`, measure: () => measureAnchor(id) })),
];

const NOT_COMPUTABLE: Array<{ id: string; title: string; reason: string }> = [
  { id: 'P6', title: 'one event, one count', reason: 'needs record-level provenance through every term; the scorer aggregates before it emits terms' },
  { id: 'P13', title: 'live signal is real', reason: 'needs outcome data (next-period ACLED/UCDP fatalities, INFORM human hazard) that no fixture carries' },
  { id: 'P16', title: 'benchmark agreement ρ ≥ 0.75 vs GPI/FSI/INFORM/ACLED', reason: 'needs external benchmark tables; measure with the methodology review, not CI' },
];

const gaps = KNOWN_GAPS[CII_FORMULA_VERSION] ?? new Set<string>();
const results = PROPERTIES.map((p) => ({ ...p, ...p.measure(), known: gaps.has(p.id) }));

describe(`CII invariants (${CII_FORMULA_VERSION}, ${FIXTURES.length} fixtures)`, () => {
  it('runs on at least three committed fixture dates', () => {
    assert.ok(FIXTURES.length >= 3, `found ${FIXTURES.length} fixtures in tests/fixtures/cii/`);
  });

  for (const r of results) {
    const name = `${r.id} ${r.title} [${CII_FORMULA_VERSION}: ${r.value}]`;
    // A known gap was measured above and its value is in the name; the ratchet
    // below fails once it passes, so its body has nothing left to assert.
    if (r.known) it(name, { todo: `known ${CII_FORMULA_VERSION} gap` }, () => {});
    else it(name, () => assert.ok(r.pass, r.value));
  }
  for (const p of NOT_COMPUTABLE) it(`${p.id} ${p.title}`, { todo: `not computable in CI: ${p.reason}` });

  it('every known gap still fails (remove a property from KNOWN_GAPS once the formula meets it)', () => {
    const fixed = results.filter((r) => r.known && r.pass).map((r) => r.id);
    assert.deepEqual(fixed, [], `now passing, promote to a real assertion: ${fixed.join(', ')}`);
    const unknown = [...gaps].filter((id) => !results.some((r) => r.id === id));
    assert.deepEqual(unknown, [], `KNOWN_GAPS names unmeasured properties: ${unknown.join(', ')}`);
  });
});

after(() => {
  const lines = [
    `CII invariants, ${CII_FORMULA_VERSION}, fixtures ${FIXTURES.map((f) => f.label).join(', ')}`,
    ...results.map((r) => `${r.id.padEnd(5)} ${(r.pass ? 'pass' : r.known ? 'todo' : 'FAIL').padEnd(5)} ${r.value}`),
    ...NOT_COMPUTABLE.map((p) => `${p.id.padEnd(5)} todo  not computable: ${p.reason}`),
    `pass ${results.filter((r) => r.pass).length}, todo ${results.filter((r) => !r.pass && r.known).length + NOT_COMPUTABLE.length}, fail ${results.filter((r) => !r.pass && !r.known).length}`,
  ];
  console.log(lines.join('\n'));
});
