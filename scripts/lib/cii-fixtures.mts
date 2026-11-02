// CII fixtures: captured production inputs for the scoring seam
// (computeCiiScoreTable in server/worldmonitor/intelligence/v1/get-risk-scores.ts).
// Used by scripts/cii-capture-fixture.mts, scripts/cii-table-diff.mts and
// tests/cii-invariants.test.mts. See docs/methodology/cii-change-brief.md.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import iso3ToIso2 from '../../shared/iso3-to-iso2.json' with { type: 'json' };
import { ciiCountryForIso2 } from '../shared/cii-country-borders.mjs';
import { parseWildfireFiresSummary, summarizeWildfireDetections } from '../shared/wildfire-fires-summary.mjs';
import {
  assessCiiInputAvailability,
  computeCiiScoreTable,
  geoToCountry,
  normalizeCountryName,
  strikeEventCountry,
  type CiiRawInputs,
  type CiiScoreTable,
} from '../../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES } from '../../server/worldmonitor/intelligence/v1/_shared.ts';

export const CII_FIXTURE_SCHEMA = 'worldmonitor-cii-fixture/v1';
export const CII_FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/cii');

/** One country's score as a formula version computed it on a fixture. */
export interface CiiFixtureExpectedRow {
  combinedScore: number;
  /** Rounded to 4 decimals. */
  blended: number;
  floor: number;
  bindingFloors: string[];
}

export interface CiiFixture {
  schema: typeof CII_FIXTURE_SCHEMA;
  /** File stem, e.g. 2026-10-23T0757Z. */
  label: string;
  /** When the inputs were read from production Redis. */
  capturedAt: string;
  /** The clock value the seam scores with: production's computedAt when it is known. */
  nowMs: number;
  iranEventsEnabled: boolean;
  /** Production has had no ACLED access since 2026-07; fixtures carry no ACLED rows. */
  acledConfigured: boolean;
  notes: string[];
  inputs: CiiRawInputs;
  /** The seam's output per formula version, keyed by CII_FORMULA_VERSION. */
  expected: Record<string, Record<string, CiiFixtureExpectedRow>>;
  /** The table production stored at the same time, when it was captured. */
  production: { key: string; computedAt: number; methodologyVersion: string; scores: Record<string, number> } | null;
}

export function loadCiiFixtures(dir = CII_FIXTURE_DIR): CiiFixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as CiiFixture)
    .filter((fixture) => fixture.schema === CII_FIXTURE_SCHEMA);
}

export function expectedFromTable(table: CiiScoreTable): Record<string, CiiFixtureExpectedRow> {
  const out: Record<string, CiiFixtureExpectedRow> = {};
  for (const row of [...table.rows].sort((a, b) => a.region.localeCompare(b.region))) {
    out[row.region] = {
      combinedScore: row.combinedScore,
      blended: Math.round(row.blended * 1e4) / 1e4,
      floor: row.floor,
      bindingFloors: row.bindingFloors,
    };
  }
  return out;
}

// ------------------------------------------------------------------------
// Trimming. The repository is public and fixtures must stay small, so a
// captured payload keeps only the fields the scorer reads and only the rows
// that can reach a Tier-1 country. Strike-feed events lose their text, source
// and channel: only severity, time and the resolved country remain. Each
// rule must leave the scores and every term unchanged; the capture script
// checks that by scoring the raw and the trimmed inputs.
// ------------------------------------------------------------------------

const TIER1 = new Set(Object.keys(TIER1_COUNTRIES));
const ISO3_TO_ISO2 = iso3ToIso2 as Record<string, string>;
const MAX_ROWS = 10000;

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const rows = (v: unknown, field: string): Obj[] => {
  const a = isObj(v) && Array.isArray(v[field]) ? v[field] : Array.isArray(v) ? v : [];
  return a.slice(0, MAX_ROWS);
};
const pick = (row: Obj, keys: string[]): Obj => {
  const out: Obj = {};
  for (const key of keys) if (row?.[key] !== undefined) out[key] = row[key];
  return out;
};
const tier1Entries = (v: unknown): Obj => (isObj(v)
  ? Object.fromEntries(Object.entries(v).filter(([code]) => TIER1.has(code)))
  : {});
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nameCode = (name: unknown) => {
  const code = normalizeCountryName(String(name || ''));
  return code && TIER1.has(code) ? code : null;
};

const NEWS_WEIGHTED = new Set(['critical', 'high', 'medium', 'elevated', 'moderate', 'low']);

function trimNewsStory(story: Obj): Obj {
  const countryCode = typeof story.countryCode === 'string' ? story.countryCode : null;
  const countryCodes = Array.isArray(story.countryCodes)
    ? story.countryCodes.filter((c: unknown): c is string => typeof c === 'string')
    : [];
  const threatLevel = typeof story.threatLevel === 'string' ? story.threatLevel : 'low';
  const named = countryCodes.length ? countryCodes : countryCode ? [countryCode] : [];
  // The headline is read only to place a story that names no tracked country.
  // Replace it with that country's name, which matches the same country.
  let primaryTitle = '';
  if (NEWS_WEIGHTED.has(threatLevel.toLowerCase()) && !named.some((c) => TIER1.has(c))) {
    const titleCode = nameCode(story.primaryTitle);
    if (titleCode) {
      const name = TIER1_COUNTRIES[titleCode as keyof typeof TIER1_COUNTRIES];
      primaryTitle = normalizeCountryName(name) === titleCode ? name : String(story.primaryTitle);
    }
  }
  return { countryCode, countryCodes, threatLevel, primaryTitle };
}

/** The build's fires input: the summary key, or the canonical payload summarized when the summary is missing. */
export function ciiFiresInput(summaryRaw: unknown, canonicalRaw: unknown): unknown {
  return summaryRaw
    ?? (canonicalRaw == null ? null : summarizeWildfireDetections(canonicalRaw) ?? canonicalRaw);
}

// The fire boost counts every high detection (bright or high radiative power)
// but at most CII_FIRE_COUNT_READ detections in all, so other rows past that
// many cannot move a score.
const CII_FIRE_COUNT_READ = 20;
const isHighFire = (f: { brightness: number; frp: number }) => f.brightness >= 360 || f.frp >= 50;

function trimFires(raw: unknown): unknown {
  if (raw == null) return null;
  const parsed = parseWildfireFiresSummary(raw);
  if (!parsed) return raw;
  const byCountry: Record<string, Array<{ brightness: number; frp: number }>> = {};
  for (const [code, fires] of Object.entries(parsed.byCountry)) {
    if (!TIER1.has(code)) continue;
    const high = fires.filter(isHighFire);
    const other = fires.filter((f) => !isHighFire(f)).slice(0, Math.max(0, CII_FIRE_COUNT_READ - high.length));
    byCountry[code] = [...high, ...other];
  }
  return { schemaVersion: parsed.schemaVersion, totalCount: parsed.totalCount, firms: parsed.firms, byCountry };
}

function trimDisplacement(raw: unknown): unknown {
  if (raw == null) return null;
  const keep = (list: Obj[]) => list
    .map((c) => ({ code: String(c.code || '').toUpperCase(), totalDisplaced: c.totalDisplaced }))
    .filter((c) => c.code && TIER1.has(ISO3_TO_ISO2[c.code] ?? ''));
  const top = rows(raw, 'countries');
  if (top.length) return { countries: keep(top) };
  return { summary: { countries: keep(rows((raw as Obj)?.summary, 'countries')) } };
}

function trimStrikeTally(raw: unknown): unknown {
  if (!isObj(raw)) return raw ?? null;
  const days: Obj = {};
  for (const [date, byCountry] of Object.entries(isObj(raw.days) ? raw.days : {})) {
    if (!isObj(byCountry)) continue;
    const kept = Object.fromEntries(Object.entries(byCountry).filter(([iso2]) => ciiCountryForIso2(iso2)));
    if (Object.keys(kept).length) days[date] = kept;
  }
  return { version: raw.version, updatedAt: raw.updatedAt, days };
}

export function trimCiiRawInputs(raw: CiiRawInputs): CiiRawInputs {
  const nullable = <T,>(v: unknown, fn: (v: any) => T): T | null => (v == null ? null : fn(v));
  return {
    ucdp: nullable(raw.ucdp, (v) => ({
      events: rows(v, 'events')
        .filter((e) => nameCode(e?.country || e?.location))
        .map((e) => pick(e, e?.country ? ['country', 'dateStart', 'deathsBest'] : ['location', 'dateStart', 'deathsBest'])),
    })),
    // `country` is not scored; it shows which records the countryCode reader fails to map.
    outages: nullable(raw.outages, (v) => ({
      outages: rows(v, 'outages').map((o) => pick(o, ['countryCode', 'country_code', 'severity', 'country'])),
    })),
    climate: nullable(raw.climate, (v) => ({
      anomalies: rows(v, 'anomalies').map((a) => pick(a, ['zone', 'region', 'severity', 'score', 'location', 'lat', 'lon', 'latitude', 'longitude', 'lng'])),
    })),
    fires: trimFires(raw.fires),
    gpsjam: nullable(raw.gpsjam, (v) => ({
      hexes: rows(v, 'hexes').flatMap((h) => {
        const lat = num(h.lat || h.latitude);
        const lon = num(h.lon || h.longitude);
        return geoToCountry(lat, lon) ? [{ lat, lon, level: h.level }] : [];
      }),
    })),
    iranEvents: nullable(raw.iranEvents, (v) => ({
      events: rows(v, 'events').flatMap((e) => {
        const severity = String(e?.severity ?? '').toLowerCase();
        const code = strikeEventCountry(e);
        return code && typeof e?.timestamp === 'number' && Number.isFinite(e.timestamp)
          ? [{ severity, timestamp: e.timestamp, countryCode: code }]
          : [];
      }),
    })),
    oref: nullable(raw.oref, (v) => pick(v, ['activeAlertCount', 'historyCount24h'])),
    advisories: nullable(raw.advisories, (v) => (isObj(v.byCountry) ? { byCountry: tier1Entries(v.byCountry) } : {})),
    displacement: trimDisplacement(raw.displacement),
    newsInsights: nullable(raw.newsInsights, (v) => ({
      topStories: (Array.isArray(v.topStories) ? v.topStories : []).map(trimNewsStory),
    })),
    threatSummary: nullable(raw.threatSummary, (v) => (isObj(v.byCountry) ? { byCountry: tier1Entries(v.byCountry) } : {})),
    aviation: nullable(raw.aviation, (v) => ({
      alerts: rows(v, 'alerts').filter((a) => nameCode(a.country)).map((a) => pick(a, ['country', 'delayType', 'severity'])),
    })),
    earthquakes: nullable(raw.earthquakes, (v) => ({
      earthquakes: rows(v, 'earthquakes')
        .filter((eq) => num(eq.magnitude) >= 5.5)
        .map((eq) => pick(eq, ['magnitude', 'occurredAt', 'location', 'place'])),
    })),
    sanctionsPressure: nullable(raw.sanctionsPressure, (v) => ({
      countries: rows(v, 'countries')
        .filter((c) => TIER1.has(String(c.countryCode || '').toUpperCase()))
        .map((c) => pick(c, ['countryCode', 'entryCount', 'newEntryCount'])),
    })),
    sanctionsCounts: nullable(raw.sanctionsCounts, (v) => (isObj(v)
      ? Object.fromEntries(Object.entries(v).filter(([code]) => TIER1.has(code.toUpperCase())))
      : v)),
    temporalAnomalies: nullable(raw.temporalAnomalies, (v) => ({
      anomalies: rows(v, 'anomalies').map((a) => pick(a, ['region', 'severity'])),
    })),
    militaryCii: nullable(raw.militaryCii, (v) => (isObj(v.byCountry) ? {
      byCountry: Object.fromEntries(Object.entries(tier1Entries(v.byCountry)).map(([code, m]) => [code, pick(m as Obj, [
        'ownFlights', 'foreignFlights', 'ownVessels', 'foreignVessels', 'aisDisruptionHigh', 'aisDisruptionElevated', 'aisDisruptionLow',
      ])])),
    } : {})),
    gdeltCountryEvents: nullable(raw.gdeltCountryEvents, (v) => ({
      ...pick(v, ['baselineReady', 'currentComplete', 'weekReady', 'updatedAt', 'strikeDays']),
      byCountry: Object.fromEntries(Object.entries(tier1Entries(v.byCountry))
        .map(([code, row]) => [code, pick(row as Obj, ['conflict', 'protest', 'week', 'strikes'])])),
    })),
    strikePressure: trimStrikeTally(raw.strikePressure),
    // Seed envelopes of public aggregate border statistics, kept whole: the
    // projection reads most of their fields.
    crossBorder: raw.crossBorder ?? {},
  };
}

// ------------------------------------------------------------------------
// Whole-table statistics shared by the diff script and the invariant suite.
// ------------------------------------------------------------------------

export interface CiiTableRowLike { region: string; blended: number; combinedScore: number }

/** Countries whose final exceeds the blend by more than 5: a floor, not evidence, set the score. */
export function floorLiftedCount(rows: CiiTableRowLike[]): number {
  return rows.filter((r) => r.combinedScore - r.blended > 5).length;
}

export function distinctScoreCount(rows: Array<{ combinedScore: number }>, precision = 0.1): number {
  return new Set(rows.map((r) => Math.round(r.combinedScore / precision))).size;
}

/** Pairs the final orders against the blend: A blends above B but scores below it. */
export function pairsOrderedAgainstBlend(rows: CiiTableRowLike[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const a of rows) {
    for (const b of rows) {
      if (a.blended > b.blended && a.combinedScore < b.combinedScore) out.push([a.region, b.region]);
    }
  }
  return out;
}

function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation with average ranks for ties; NaN when either side is constant. */
export function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

export function scoreCiiFixture(fixture: Pick<CiiFixture, 'inputs' | 'nowMs' | 'iranEventsEnabled'>): CiiScoreTable {
  return computeCiiScoreTable(fixture.inputs, { nowMs: fixture.nowMs, iranEventsEnabled: fixture.iranEventsEnabled });
}

/**
 * Trims raw inputs into a fixture and proves the trim is neutral: every
 * country's terms and score, and every input's health state, must match the
 * untrimmed inputs exactly, or this throws.
 */
export function buildCiiFixture(raw: CiiRawInputs, meta: {
  label: string;
  capturedAt: string;
  nowMs: number;
  iranEventsEnabled: boolean;
  notes: string[];
  production: CiiFixture['production'];
}): CiiFixture {
  const inputs = trimCiiRawInputs(raw);
  const options = { nowMs: meta.nowMs, iranEventsEnabled: meta.iranEventsEnabled };
  const full = computeCiiScoreTable(raw, options);
  const trimmed = computeCiiScoreTable(inputs, options);
  const fingerprint = (table: CiiScoreTable) => JSON.stringify({
    rows: table.rows,
    health: assessCiiInputAvailability([], table.aux, meta.nowMs, false),
  });
  if (fingerprint(full) !== fingerprint(trimmed)) {
    const changed = full.rows
      .filter((row, i) => JSON.stringify(row) !== JSON.stringify(trimmed.rows[i]))
      .map((row) => row.region);
    throw new Error(`trimming changed the score table (${changed.join(', ') || 'input health'})`);
  }
  return {
    schema: CII_FIXTURE_SCHEMA,
    label: meta.label,
    capturedAt: meta.capturedAt,
    nowMs: meta.nowMs,
    iranEventsEnabled: meta.iranEventsEnabled,
    acledConfigured: false,
    notes: meta.notes,
    inputs,
    expected: { [CII_FORMULA_VERSION]: expectedFromTable(trimmed) },
    production: meta.production,
  };
}
