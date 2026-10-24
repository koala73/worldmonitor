import type {
  ServerContext,
  GetRiskScoresRequest,
  GetRiskScoresResponse,
  CiiScore,
  StrategicRisk,
  TrendDirection,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { CROSS_BORDER_SOURCES, projectCrossBorderSnapshots } from '../../displacement/v1/cross-border-data';
import iso3ToIso2Json from '../../../../shared/iso3-to-iso2.json';
import { getCachedJson, readCachedJson, readCachedEnvelopeJson, setCachedJson, cachedFetchJsonWithMeta, runRedisPipeline } from '../../../_shared/redis';
import { CLIMATE_ANOMALIES_KEY, CII_RISK_SCORE_CACHE_KEYS } from '../../../_shared/cache-keys';
import { CII_DAY_MS, parseCiiDailyPoints } from '../../../../shared/cii-daily-history';
import { ciiCountryAt, ciiCountryForIso2, ciiIsLand } from '../../../../scripts/shared/cii-country-borders.mjs';
import {
  parseWildfireFiresSummary,
  summarizeWildfireDetections,
  WILDFIRE_FIRES_SUMMARY_KEY,
  type WildfireFireIntensity,
} from '../../../../scripts/shared/wildfire-fires-summary.mjs';
import { TIER1_COUNTRIES } from './_shared';
import { fetchAcledCached } from '../../../_shared/acled';
import { isAcledConfigured } from '../../../_shared/acled-auth';
import {
  CII_CONFLICT_ACTIVITY_CAP,
  CII_CONFLICT_ACTIVITY_PIVOT,
  CII_FORMULA_VERSION,
  CII_GDELT_ESCALATION_CAP,
  CII_GDELT_ESCALATION_DEADBAND,
  CII_GDELT_ESCALATION_MAX_AGE_MS,
  CII_GDELT_ESCALATION_SATURATION,
  CII_GDELT_ESCALATION_SMOOTHING,
  CII_GDELT_LEVEL_CONFLICT_FLOOR,
  CII_GDELT_LEVEL_CONFLICT_SATURATION,
  CII_GDELT_LEVEL_MIN_ARTICLES,
  CII_GDELT_LEVEL_PROTEST_FLOOR,
  CII_GDELT_LEVEL_PROTEST_SATURATION,
  CII_STRIKE_BOOST_CAP,
  CII_STRIKE_BOOST_PER_DOUBLING,
  CII_STRIKE_BOOST_PIVOT,
  CII_STRIKE_CONFIRMED_MAX_AGE_MS,
  CII_STRIKE_FLOOR_BASE,
  CII_STRIKE_FLOOR_CAP,
  CII_STRIKE_FLOOR_MIN_PRESSURE,
  CII_STRIKE_FLOOR_PER_DOUBLING,
  CII_STRIKE_GDELT_MIN_MEASURED_DAYS,
  CII_STRIKE_GDELT_NOISE_FLOOR,
  CII_STRIKE_GDELT_SCALE,
  CII_STRIKE_GDELT_SMOOTHING,
  CII_STRIKE_GDELT_SUSTAINED_DAYS,
  CII_STRIKE_HALF_LIFE_DAYS,
  CII_STRIKE_SEVERITY_WEIGHTS,
  CII_STRIKE_WINDOW_DAYS,
  CII_POPULATION_MILLIONS,
  CII_UCDP_CONFLICT_CAP,
  CII_UCDP_HALF_LIFE_DAYS,
  CII_UCDP_MAX_LAG_DAYS,
  CII_UCDP_MIN_MONTH_SHARE,
  CII_UCDP_RATE_KNEE,
  CII_UCDP_RATE_SATURATION,
  CII_UCDP_WINDOW_DAYS,
  STRATEGIC_RISK_POSITIONAL_DECAY,
  STRATEGIC_RISK_SCALE_FACTOR,
  STRATEGIC_RISK_SCALE_FLOOR,
  STRATEGIC_RISK_TOP_N,
} from './_risk-config';
import {
  CII_COUNTRY_CODES,
  CII_BASELINE_RISK,
  CII_EVENT_MULTIPLIER,
  DEFAULT_CII_BASELINE_RISK,
  DEFAULT_CII_EVENT_MULTIPLIER,
} from '../../../../shared/cii-weights';
import { CII_CLIMATE_ZONE_COUNTRIES } from '../../../../shared/cii-climate-zones';

// ========================================================================
// Country risk baselines and multipliers
// ------------------------------------------------------------------------
// Editorial values — see docs/methodology/cii-risk-scores.mdx for the
// published table and the rationale. The authoritative coefficient table
// lives in shared/cii-weights.ts so browser-side scoring and server-side
// scoring cannot drift.
//
// Before any change that can move a score, read
// docs/methodology/cii-change-brief.md: claim the version in
// docs/methodology/cii-next.json, run tests/cii-invariants.test.mts and post
// scripts/cii-table-diff.mts output for tests/fixtures/cii/.
// Change protocol when editing coefficient values in shared/cii-weights.ts:
//   1. Bump CII_FORMULA_VERSION in ./_risk-config.ts if server/API scores shift.
//   2. Update docs/methodology/cii-risk-scores.mdx in the SAME commit.
//   3. Mention the change in CHANGELOG.md (public-facing section).
// Climate-zone attribution has the same protocol when it changes server/API
// scores; its canonical map documents that ownership in shared/cii-climate-zones.ts.
// ========================================================================

// Exported so tests and any internal diagnostics can assert the published
// methodology doc rows match the shared source exactly.
export const BASELINE_RISK: Record<string, number> = { ...CII_BASELINE_RISK };
export const EVENT_MULTIPLIER: Record<string, number> = { ...CII_EVENT_MULTIPLIER };

const COUNTRY_KEYWORDS: Record<string, string[]> = {
  US: ['united states', 'usa', 'u.s.', 'u.s.a.', 'america', 'american', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'russian', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'chinese', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'iranian', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'israeli', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taiwanese', 'taipei'],
  KP: ['north korea', 'north korean', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'saudi', 'riyadh'],
  TR: ['turkey', 'turkiye', 'turkish', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'german', 'berlin'],
  FR: ['france', 'french', 'paris', 'macron'],
  GB: ['united kingdom', 'britain', 'british', 'uk', 'u.k.', 'london'],
  IN: ['india', 'indian', 'delhi', 'modi'],
  PK: ['pakistan', 'pakistani', 'islamabad'],
  SY: ['syria', 'syrian', 'damascus'],
  YE: ['yemen', 'yemeni', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma', 'burmese'],
  VE: ['venezuela', 'venezuelan', 'caracas', 'maduro'],
  CU: ['cuba', 'cuban', 'havana', 'diaz-canel'],
  MX: ['mexico', 'mexican', 'sheinbaum', 'cartel', 'sinaloa'],
  BR: ['brazil', 'brazilian', 'brasilia', 'lula'],
  AE: ['uae', 'emirates', 'dubai', 'abu dhabi', 'united arab emirates'],
  KR: ['south korea', 'south korean', 'korean peninsula', 'seoul', 'yoon'],
  IQ: ['iraq', 'iraqi', 'baghdad', 'kurdistan', 'mosul', 'basra'],
  AF: ['afghanistan', 'afghan', 'kabul', 'taliban', 'kandahar'],
  LB: ['lebanon', 'lebanese', 'beirut', 'hezbollah', 'nasrallah'],
  EG: ['egypt', 'egyptian', 'cairo', 'suez', 'sisi'],
  JP: ['japan', 'japanese', 'tokyo', 'okinawa', 'fukushima', 'kishida'],
  QA: ['qatar', 'qatari', 'doha', 'al jazeera'],
};

const ADVISORY_LEVELS_FALLBACK: Record<string, 'do-not-travel' | 'reconsider' | 'caution'> = {
  // These floors are score-affecting methodology inputs; new country additions
  // must go through a formula-version/docs changelog batch.
  UA: 'do-not-travel', SY: 'do-not-travel', YE: 'do-not-travel', MM: 'do-not-travel',
  IL: 'reconsider', IR: 'reconsider', PK: 'reconsider', VE: 'reconsider', CU: 'reconsider', MX: 'reconsider',
  RU: 'caution', TR: 'caution', IQ: 'reconsider', AF: 'do-not-travel', LB: 'reconsider',
};

type AdvisoryLevel = 'do-not-travel' | 'reconsider' | 'caution';
type AdvisoryProvenance = 'live' | 'fallback' | 'absent';

function isAdvisoryLevel(value: unknown): value is AdvisoryLevel {
  return value === 'do-not-travel' || value === 'reconsider' || value === 'caution';
}

function isAdvisoryLevelOrEmpty(value: unknown): value is AdvisoryLevel | '' {
  return value === '' || isAdvisoryLevel(value);
}

function isAdvisoryProvenance(value: unknown): value is AdvisoryProvenance {
  return value === 'live' || value === 'fallback' || value === 'absent';
}

function advisoryFallbackLevel(region: string | undefined | null): AdvisoryLevel | null {
  const code = String(region || '').trim().toUpperCase();
  return ADVISORY_LEVELS_FALLBACK[code] ?? null;
}

// ========================================================================
// Internal helpers
// ========================================================================

function normalizeForCountryMatch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const COUNTRY_KEYWORDS_NORMALIZED: Record<string, string[]> = Object.fromEntries(
  Object.entries(COUNTRY_KEYWORDS).map(([code, keywords]) => [code, keywords.map(normalizeForCountryMatch)]),
);

function hasCountryPhraseMatch(normalizedText: string, normalizedKeyword: string): boolean {
  if (!normalizedText || !normalizedKeyword) return false;
  return ` ${normalizedText} `.includes(` ${normalizedKeyword} `);
}

export function normalizeCountryName(text: string): string | null {
  const normalized = normalizeForCountryMatch(text);
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS_NORMALIZED)) {
    if (keywords.some((kw) => hasCountryPhraseMatch(normalized, kw))) return code;
  }
  return null;
}

function climateSeverityScore(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = String(value || '').toLowerCase();
  // These values are chosen so the later climateBoost = min(15, severity * 3)
  // matches browser fallback boosts: extreme = 15 and moderate = 8.
  if (normalized.includes('extreme')) return 5; // 5 * 3 => climateBoost 15.
  if (normalized.includes('moderate')) return 8 / 3; // 8 / 3 * 3 => climateBoost 8.
  return 0;
}

function getClimateAnomalyCoordinateCountry(anomaly: any): string | null {
  const lat = anomaly?.location?.latitude ?? anomaly?.lat ?? anomaly?.latitude;
  const lon = anomaly?.location?.longitude ?? anomaly?.lon ?? anomaly?.longitude ?? anomaly?.lng;
  if (lat == null || lon == null) return null;
  return geoToCountry(Number(lat), Number(lon));
}

export function climateCountriesForAnomaly(anomaly: any): string[] {
  const zone = anomaly?.zone || anomaly?.region || '';
  const countries = new Set<string>(CII_CLIMATE_ZONE_COUNTRIES[zone] || []);
  const coordinateCountry = getClimateAnomalyCoordinateCountry(anomaly);
  if (coordinateCountry) countries.add(coordinateCountry);
  return [...countries].filter((code) => code in TIER1_COUNTRIES);
}

// Real borders (scripts/shared/cii-country-borders.mjs, generated from the
// Natural Earth 1:50m map), shared with scripts/seed-military-cii.mjs so the
// military seeder places flights and vessels exactly as the scorer does.
// Points on non-Tier-1 land, or more than 12 nautical miles offshore, are null.
export const geoToCountry: (lat: number, lon: number) => string | null = ciiCountryAt;

// An earthquake scores where its epicentre is. Offshore beyond coastal waters,
// where bounding boxes used to reach, it takes the country USGS names after the
// last comma ("151 km E of Namie, Japan") when that text is exactly a country
// name: never an ocean or region ("Southern Indian Ocean" is not India), and
// never for an epicentre on non-Tier-1 land, which counts for no Tier-1 country
// even when USGS describes it from a town across the border.
function earthquakeCountry(eq: any): string | null {
  const lat = safeNum(eq?.location?.latitude);
  const lon = safeNum(eq?.location?.longitude);
  const code = geoToCountry(lat, lon);
  if (code || ciiIsLand(lat, lon)) return code;
  const place = String(eq?.place || '');
  const comma = place.lastIndexOf(',');
  return comma < 0 ? null : countryNamedExactly(place.slice(comma + 1));
}

// Country names only, not news keywords: USGS writes US states after the comma
// ("Washington") and COUNTRY_KEYWORDS carries cities and leaders.
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  'united states of america': 'US', usa: 'US', 'russian federation': 'RU',
  turkiye: 'TR', burma: 'MM', uae: 'AE', uk: 'GB', 'great britain': 'GB',
  'republic of korea': 'KR', 'democratic people s republic of korea': 'KP',
};
const COUNTRY_NAME_TO_CODE: Map<string, string> = new Map([
  ...Object.entries(TIER1_COUNTRIES).map(([code, name]) => [normalizeForCountryMatch(name), code] as [string, string]),
  ...Object.entries(COUNTRY_NAME_ALIASES).map(([name, code]) => [normalizeForCountryMatch(name), code] as [string, string]),
]);

function countryNamedExactly(text: string): string | null {
  return COUNTRY_NAME_TO_CODE.get(normalizeForCountryMatch(text)) ?? null;
}

// A strike event that carries its country (the Middle East strike feed sets
// countryCode from its gazetteer) scores there, including at sea where no
// polygon reaches; a non-Tier-1 country scores nowhere. Older events without
// it fall back to their coordinates, then to the country named in the text.
export function strikeEventCountry(s: any): string | null {
  if (typeof s?.countryCode === 'string' && /^[A-Za-z]{2}$/.test(s.countryCode.trim())) {
    return ciiCountryForIso2(s.countryCode);
  }
  const lat = safeNum(s?.lat || s?.latitude);
  const lon = safeNum(s?.lon || s?.longitude);
  return geoToCountry(lat, lon) || normalizeCountryName(s?.title || s?.location || '');
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeNonNegativeNum(v: unknown): number {
  return Math.max(0, safeNum(v));
}

function logScaledScore(raw: number, cap: number, pivot: number): number {
  const value = Math.max(0, raw);
  if (value === 0) return 0;
  return Math.min(cap, (Math.log1p(value) / Math.log1p(pivot)) * cap);
}

export const CII_TREND_DEADBAND_POINTS = 1;
export const CII_TREND_TARGET_AGE_MS = 24 * 60 * 60 * 1000;
export const CII_TREND_BUCKET_MS = 10 * 60 * 1000;
export const CII_TREND_BUCKET_LOOKUP_RADIUS = 3;
export const CII_TREND_PRIOR_MIN_AGE_MS =
  CII_TREND_TARGET_AGE_MS - CII_TREND_BUCKET_LOOKUP_RADIUS * CII_TREND_BUCKET_MS;
export const CII_TREND_PRIOR_MAX_AGE_MS =
  CII_TREND_TARGET_AGE_MS + CII_TREND_BUCKET_LOOKUP_RADIUS * CII_TREND_BUCKET_MS;

interface CiiTrendComparisonOptions {
  priorScores?: CiiScore[] | null;
  nowMs?: number;
}

export interface CiiTrendSnapshot {
  capturedAt: number;
  ciiScores: CiiScore[];
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundCiiDelta(delta: number): number {
  return Math.round(delta * 10) / 10;
}

export function deriveCiiTrendDelta(
  combinedScore: number,
  priorScore: Pick<CiiScore, 'combinedScore' | 'computedAt'> | undefined,
  nowMs: number,
): { dynamicScore: number; trend: TrendDirection } {
  const previous = finiteNumber(priorScore?.combinedScore);
  const priorComputedAt = finiteNumber(priorScore?.computedAt);
  const priorAgeMs = priorComputedAt === null ? null : nowMs - priorComputedAt;
  if (
    previous === null ||
    priorComputedAt === null ||
    priorComputedAt <= 0 ||
    priorComputedAt > nowMs ||
    priorAgeMs === null ||
    priorAgeMs < CII_TREND_PRIOR_MIN_AGE_MS ||
    priorAgeMs > CII_TREND_PRIOR_MAX_AGE_MS
  ) {
    // No usable prior reading means the movement is unknown, not zero. STABLE
    // is reserved for a real comparison inside the deadband; readers render
    // UNSPECIFIED as "no earlier reading" instead of "unchanged".
    return { dynamicScore: 0, trend: 'TREND_DIRECTION_UNSPECIFIED' as TrendDirection };
  }

  const dynamicScore = roundCiiDelta(combinedScore - previous);
  // Composite CII scores are whole points, so strict > 1 / < -1 keeps a
  // one-point move stable; two integer points is the first directional label.
  const trend = dynamicScore > CII_TREND_DEADBAND_POINTS
    ? 'TREND_DIRECTION_RISING'
    : dynamicScore < -CII_TREND_DEADBAND_POINTS
      ? 'TREND_DIRECTION_FALLING'
      : 'TREND_DIRECTION_STABLE';

  return { dynamicScore, trend: trend as TrendDirection };
}

function buildPriorCiiScoreMap(priorScores: CiiScore[] | null | undefined): Map<string, CiiScore> {
  const byRegion = new Map<string, CiiScore>();
  for (const score of priorScores ?? []) {
    const region = String(score.region || '').trim().toUpperCase();
    if (!region) continue;

    const existing = byRegion.get(region);
    const existingComputedAt = finiteNumber(existing?.computedAt) ?? -Infinity;
    const scoreComputedAt = finiteNumber(score.computedAt) ?? -Infinity;
    if (!existing || scoreComputedAt > existingComputedAt) byRegion.set(region, score);
  }
  return byRegion;
}

const ISO3_TO_ISO2: Record<string, string> = iso3ToIso2Json;

// --- UCDP organised violence (v15) ---
//
// The cached `conflict:ucdp-events:v1` payload (scripts/seed-ucdp-events.mjs and
// scripts/ais-relay.cjs) carries `countryDays`: per UCDP country name, one
// [UTC day, events, deaths] row per day of the writers' trailing window, built
// from every GED and GED Candidate event in it, plus `dailyTotals`, the events
// per day across all countries. Its `events` list is a capped newest slice for
// the map and the RPC, too short for a one-year term. A payload written before
// countryDays existed (and the fixtures captured from one) is read from
// `events`, one row per event. See CII_UCDP_* in ./_risk-config for the term.
const UCDP_KERNEL_YEARS = (CII_UCDP_HALF_LIFE_DAYS / Math.LN2)
  * (1 - 0.5 ** (CII_UCDP_WINDOW_DAYS / CII_UCDP_HALF_LIFE_DAYS)) / 365;

/** One UCDP row as the term reads it: an event, or one country-day of the writers' aggregate. */
export interface CiiUcdpRow { country?: string; location?: string; dateStart: number; deathsBest: number; events?: number }

/**
 * Rows and global day totals from the cached payload, in either shape, and
 * whether the writers fetched the whole window (`window.complete`; null for a
 * payload without it). A release with a failed page can leave a month dense
 * enough to pass the read-time check while the writers know it is short.
 */
export function parseUcdpCache(raw: unknown): {
  rows: CiiUcdpRow[];
  dailyTotals: Record<string, number> | null;
  writerComplete: boolean | null;
  /** Months after the newest data whose release UCDP has not published yet (the writers' `window.upstreamGapMonths`). */
  upstreamGapMonths: string[];
} {
  const payload = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const countryDays = payload?.countryDays;
  const window = payload?.window && typeof payload.window === 'object' ? payload.window as Record<string, unknown> : null;
  const writerComplete = typeof window?.complete === 'boolean' ? window.complete : null;
  const upstreamGapMonths = Array.isArray(window?.upstreamGapMonths)
    ? (window.upstreamGapMonths as unknown[]).filter((m): m is string => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m))
    : [];
  if (!countryDays || typeof countryDays !== 'object' || Array.isArray(countryDays)) {
    const events = Array.isArray(raw) ? raw : Array.isArray(payload?.events) ? payload.events : [];
    return { rows: (events as CiiUcdpRow[]).slice(0, 10000), dailyTotals: null, writerComplete, upstreamGapMonths };
  }
  const rows: CiiUcdpRow[] = [];
  for (const [country, days] of Object.entries(countryDays as Record<string, unknown>)) {
    if (!Array.isArray(days)) continue;
    for (const day of days) {
      if (!Array.isArray(day)) continue;
      const dayIndex = finiteNumber(day[0]);
      if (dayIndex === null) continue;
      rows.push({ country, dateStart: dayIndex * CII_DAY_MS, events: safeNonNegativeNum(day[1]), deathsBest: safeNonNegativeNum(day[2]) });
    }
  }
  const dailyTotals: Record<string, number> = {};
  for (const entry of Array.isArray(payload?.dailyTotals) ? payload.dailyTotals : []) {
    const dayIndex = Array.isArray(entry) ? finiteNumber(entry[0]) : null;
    if (dayIndex !== null) dailyTotals[String(dayIndex)] = safeNonNegativeNum(entry[1]);
  }
  return { rows, dailyTotals: Object.keys(dailyTotals).length ? dailyTotals : null, writerComplete, upstreamGapMonths };
}

/** Age in days, or null when the row is undated, in the future or outside the window. */
function ucdpRowAgeDays(row: CiiUcdpRow | null | undefined, nowMs: number): number | null {
  const dateStart = finiteNumber(row?.dateStart);
  if (dateStart === null || !Number.isFinite(nowMs) || dateStart > nowMs) return null;
  const age = (nowMs - dateStart) / CII_DAY_MS;
  return age < CII_UCDP_WINDOW_DAYS ? age : null;
}

/**
 * Decay-weighted deaths per million people per year, by Tier-1 country. Each
 * row counts at least one death per event: UCDP records an event only when it
 * killed someone.
 */
export function ucdpViolenceRates(rows: CiiUcdpRow[] | null | undefined, nowMs: number): Record<string, number> {
  const decayed: Record<string, number> = {};
  const codeByName = new Map<string, string | null>();
  for (const row of rows ?? []) {
    const age = ucdpRowAgeDays(row, nowMs);
    if (age === null) continue;
    const name = String(row?.country || row?.location || '');
    if (!name) continue;
    if (!codeByName.has(name)) codeByName.set(name, normalizeCountryName(name));
    const code = codeByName.get(name);
    if (!code || !isTier1CountryCode(code)) continue;
    const deaths = Math.max(safeNonNegativeNum(row.deathsBest), Math.max(1, safeNonNegativeNum(row.events)));
    decayed[code] = (decayed[code] ?? 0) + deaths * 0.5 ** (age / CII_UCDP_HALF_LIFE_DAYS);
  }
  const rates: Record<string, number> = {};
  for (const [code, deaths] of Object.entries(decayed)) {
    const population = CII_POPULATION_MILLIONS[code];
    if (population && population > 0) rates[code] = deaths / (UCDP_KERNEL_YEARS * population);
  }
  return rates;
}

/** 0..CII_UCDP_CONFLICT_CAP from a rate in deaths per million people per year. */
export function ucdpViolenceScore(rate: number): number {
  if (!(rate > 0)) return 0;
  return CII_UCDP_CONFLICT_CAP * Math.min(
    1,
    Math.log1p(rate / CII_UCDP_RATE_KNEE) / Math.log1p(CII_UCDP_RATE_SATURATION / CII_UCDP_RATE_KNEE),
  );
}

/** What the cached UCDP rows cover, against the window the term assumes (P9). */
export interface CiiUcdpWindow {
  assumedDays: number;
  /** Age of the oldest and newest in-window rows, in whole days; null when there are none. */
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
  /** Calendar months (UTC) between those rows holding under CII_UCDP_MIN_MONTH_SHARE of the median non-empty month's daily events. */
  gapMonths: string[];
  /** The writers' own verdict on their fetch (`window.complete`), null when the payload has none. */
  writerComplete: boolean | null;
  /** Months after the newest data whose release UCDP has not published yet (the writers' frontier): reported only. */
  upstreamGapMonths: string[];
  honest: boolean;
}

/**
 * Read-time window check. Events per day come from the writers' global day
 * totals when the payload has them (every country, so the check is not
 * fooled by a trimmed copy), else from the rows themselves.
 */
export function assessUcdpWindow(
  rows: CiiUcdpRow[] | null | undefined,
  dailyTotals: Record<string, number> | null | undefined,
  nowMs: number,
  writerComplete: boolean | null = null,
  upstreamGapMonths: readonly string[] = [],
): CiiUcdpWindow {
  const perDay = new Map<number, number>();
  const add = (day: number, events: number) => perDay.set(day, (perDay.get(day) ?? 0) + events);
  if (dailyTotals) {
    for (const [day, events] of Object.entries(dailyTotals)) {
      const dayIndex = Number(day);
      if (ucdpRowAgeDays({ dateStart: dayIndex * CII_DAY_MS, deathsBest: 0 }, nowMs) !== null && events > 0) add(dayIndex, events);
    }
  } else {
    for (const row of rows ?? []) {
      if (ucdpRowAgeDays(row, nowMs) === null) continue;
      add(Math.floor(Number(row.dateStart) / CII_DAY_MS), Math.max(1, safeNonNegativeNum(row.events)));
    }
  }
  const days = [...perDay.keys()].sort((a, b) => a - b);
  const nowDay = Math.floor(nowMs / CII_DAY_MS);
  if (!days.length) return { assumedDays: CII_UCDP_WINDOW_DAYS, oldestAgeDays: null, newestAgeDays: null, gapMonths: [], writerComplete, upstreamGapMonths: [...upstreamGapMonths], honest: false };
  const first = days[0]!;
  const last = days[days.length - 1]!;
  // Events per covered day for each calendar month between the first and last day.
  const months = new Map<string, { events: number; days: number }>();
  for (let day = first; day <= last; day++) {
    const month = new Date(day * CII_DAY_MS).toISOString().slice(0, 7);
    const m = months.get(month) ?? { events: 0, days: 0 };
    m.events += perDay.get(day) ?? 0;
    m.days += 1;
    months.set(month, m);
  }
  // The median over months that hold events: missing months must not set the bar they are measured against.
  const rates = [...months.values()].map((m) => m.events / m.days).filter((r) => r > 0).sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)]!;
  // No month inside the rows is exempt, whatever the payload says: a release
  // UCDP has not published can only follow the newest one with data.
  const gapMonths = [...months.entries()]
    .filter(([, m]) => m.events / m.days < CII_UCDP_MIN_MONTH_SHARE * median)
    .map(([month]) => month);
  const oldestAgeDays = nowDay - first;
  const newestAgeDays = nowDay - last;
  return {
    assumedDays: CII_UCDP_WINDOW_DAYS,
    oldestAgeDays,
    newestAgeDays,
    gapMonths,
    writerComplete,
    upstreamGapMonths: [...upstreamGapMonths],
    honest: gapMonths.length === 0
      && writerComplete !== false
      && newestAgeDays <= CII_UCDP_MAX_LAG_DAYS
      && oldestAgeDays >= CII_UCDP_WINDOW_DAYS - 31,
  };
}

interface CountrySignals {
  protests: number;
  riots: number;
  battles: number;
  explosions: number;
  civilianViolence: number;
  fatalities: number;
  protestFatalities: number;
  conflictFatalities: number;
  /** GDELT term, 0..CII_GDELT_ESCALATION_CAP: max(escalation over the country's own norm, sustained level). */
  gdeltConflictEscalation: number;
  gdeltUnrestEscalation: number;
  /** UCDP organised violence, decay-weighted deaths per million people per year. */
  ucdpRate: number;
  outageTotalCount: number;
  outageMajorCount: number;
  outagePartialCount: number;
  climateSeverity: number;
  fireCount: number;
  fireHighCount: number;
  gpsHighCount: number;
  gpsMediumCount: number;
  /** Decayed strike pressure P (v12), 0 when the country has not been struck. */
  strikePressure: number;
  orefAlertCount: number;
  orefHistoryCount24h: number;
  advisoryLevel: AdvisoryLevel | null;
  advisoryProvenance: AdvisoryProvenance;
  totalDisplaced: number;
  newsScore: number;
  threatSummaryScore: number;
  // High-severity unrest event count (Phase 3b / C1) — a "high-severity" unrest event is
  // one that killed someone OR is a riot, matching seed-unrest-events.mjs classifySeverity.
  highSeverityUnrest: number;
  // Phase 1 (CII unification, docs/archive/plans/unify-cii-single-source.md) — gathered, not yet scored.
  aviationClosureCount: number;
  aviationSevereCount: number;
  aviationMajorCount: number;
  aviationModerateCount: number;
  earthquakeSignificantCount: number;
  earthquakeMajorCount: number;
  earthquakeSevereCount: number;
  sanctionsEntryCount: number;
  sanctionsNewEntryCount: number;
  temporalAnomalyCount: number;
  temporalAnomalyCriticalCount: number;
  // Phase 2 (CII unification) — gathered here and scored in the security component below.
  militaryOwnFlights: number;
  militaryForeignFlights: number;
  militaryOwnVessels: number;
  militaryForeignVessels: number;
  aisDisruptionHighCount: number;
  aisDisruptionElevatedCount: number;
  aisDisruptionLowCount: number;
}

function emptySignals(): CountrySignals {
  return {
    protests: 0, riots: 0, battles: 0, explosions: 0, civilianViolence: 0,
    fatalities: 0, protestFatalities: 0, conflictFatalities: 0,
    gdeltConflictEscalation: 0,
    gdeltUnrestEscalation: 0,
    ucdpRate: 0,
    outageTotalCount: 0, outageMajorCount: 0, outagePartialCount: 0,
    climateSeverity: 0,
    fireCount: 0, fireHighCount: 0,
    gpsHighCount: 0, gpsMediumCount: 0,
    strikePressure: 0,
    orefAlertCount: 0, orefHistoryCount24h: 0,
    advisoryLevel: null,
    advisoryProvenance: 'absent',
    totalDisplaced: 0,
    newsScore: 0,
    threatSummaryScore: 0,
    highSeverityUnrest: 0,
    aviationClosureCount: 0, aviationSevereCount: 0, aviationMajorCount: 0, aviationModerateCount: 0,
    earthquakeSignificantCount: 0, earthquakeMajorCount: 0, earthquakeSevereCount: 0,
    sanctionsEntryCount: 0, sanctionsNewEntryCount: 0,
    temporalAnomalyCount: 0, temporalAnomalyCriticalCount: 0,
    militaryOwnFlights: 0, militaryForeignFlights: 0,
    militaryOwnVessels: 0, militaryForeignVessels: 0,
    aisDisruptionHighCount: 0, aisDisruptionElevatedCount: 0, aisDisruptionLowCount: 0,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDateOnly(ms: number): string {
  return new Date(ms).toISOString().split('T')[0]!;
}

export function getAcledFetchWindows(now = Date.now()): {
  recent: { startDate: string; endDate: string };
  older: { startDate: string; endDate: string };
} {
  return {
    recent: {
      startDate: utcDateOnly(now - 7 * DAY_MS),
      endDate: utcDateOnly(now),
    },
    older: {
      startDate: utcDateOnly(now - 30 * DAY_MS),
      endDate: utcDateOnly(now - 8 * DAY_MS),
    },
  };
}

async function fetchACLEDEvents(): Promise<Array<{ country: string; event_type: string; fatalities: number; daysAgo: number }>> {
  const now = Date.now();
  const { recent: recentWindow, older: olderWindow } = getAcledFetchWindows(now);
  const eventTypes = 'Protests|Riots|Battles|Explosions/Remote violence|Violence against civilians';

  // Two separate cached queries so each window has its own 1 000-event budget.
  // A single 30-day request at limit:1500 silently drops tail events once the
  // global count exceeds the cap; splitting ensures post-conflict countries
  // (low recent activity, higher older activity) are not squeezed out.
  const [recent, older] = await Promise.all([
    fetchAcledCached({ eventTypes, startDate: recentWindow.startDate, endDate: recentWindow.endDate, limit: 1000 }),
    fetchAcledCached({ eventTypes, startDate: olderWindow.startDate, endDate: olderWindow.endDate, limit: 1000 }),
  ]);

  const toRow = (e: (typeof recent)[number]) => {
    const eventMs = e.event_date ? new Date(e.event_date).getTime() : now;
    return {
      country: e.country || '',
      event_type: e.event_type || '',
      fatalities: parseInt(e.fatalities || '0', 10) || 0,
      daysAgo: Math.max(0, Math.floor((now - eventMs) / (24 * 60 * 60 * 1000))),
    };
  };

  // Surface the otherwise-silent empty case. fetchAcledCached returns [] both
  // when ACLED auth is unconfigured (getAcledAccessToken → null) AND on upstream
  // failure (API error, rate-limit, timeout). With active conflicts ACLED returns
  // thousands of events, so 0 from BOTH windows means the conflict realtime signal
  // is dark — CII then relies on UCDP alone, which (an annual release) can fall
  // outside the 2-year recency window and flip /api/health.riskScores to
  // COVERAGE_PARTIAL. The message names both causes so an operator doesn't chase a
  // phantom auth problem during an ACLED outage.
  if (recent.length === 0 && older.length === 0) {
    console.warn(
      '[CII] ACLED returned 0 events for both windows — if auth is unconfigured set ACLED_EMAIL/ACLED_PASSWORD (or ACLED_ACCESS_TOKEN) on the api project, else check for an upstream ACLED API error/rate-limit. CII conflict realtime signal-density coverage is falling back to UCDP only.',
    );
  }

  return [...recent.map(toRow), ...older.map(toRow)];
}

export interface GdeltEscalationSignal {
  current: number;
  baselineMedian: number | null;
}

/** Distinct articles of the seven complete days through yesterday, and how many were coded. */
export interface GdeltCountryWeek {
  articles: number;
  conflict: number;
  protest: number;
}

/** { 'YYYY-MM-DD': [strikeArticles, articles] } for a country's measured strike days. */
export type GdeltStrikeCounts = Record<string, [number, number]>;

export interface GdeltCountryEventsRow {
  conflict: GdeltEscalationSignal | null;
  protest: GdeltEscalationSignal | null;
  week: GdeltCountryWeek | null;
  strikes?: GdeltStrikeCounts | null;
}

export interface GdeltCountryEvents {
  byCountry: Record<string, GdeltCountryEventsRow>;
  /** Days measured for strikes and their cohorts; null when the summary predates v12. */
  strikeDays?: Record<string, number> | null;
}

/** Strike intensity per UTC day ('YYYY-MM-DD' -> weighted strikes or their GDELT equivalent). */
export type StrikeDays = Record<string, number>;

const STRIKE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseGdeltEscalationSignal(raw: unknown): GdeltEscalationSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const { current, baselineMedian } = raw as Record<string, unknown>;
  if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) return null;
  return {
    current,
    baselineMedian: typeof baselineMedian === 'number' && Number.isFinite(baselineMedian) && baselineMedian >= 0
      ? baselineMedian
      : null,
  };
}

function parseGdeltCountryWeek(raw: unknown): GdeltCountryWeek | null {
  if (!raw || typeof raw !== 'object') return null;
  const { articles, conflict, protest } = raw as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!count(articles) || !count(conflict) || !count(protest)) return null;
  if (conflict > articles || protest > articles) return null;
  return { articles, conflict, protest };
}

function parseGdeltStrikeDays(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [date, cohorts] of Object.entries(raw as Record<string, unknown>)) {
    if (STRIKE_DATE_RE.test(date) && typeof cohorts === 'number' && Number.isInteger(cohorts) && cohorts > 0) out[date] = cohorts;
  }
  return Object.keys(out).length ? out : null;
}

function parseGdeltStrikeCounts(raw: unknown, measured: Record<string, number>): GdeltStrikeCounts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: GdeltStrikeCounts = {};
  for (const [date, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(measured, date) || !Array.isArray(value) || value.length !== 2) continue;
    const [strikes, articles] = value;
    if (typeof strikes !== 'number' || typeof articles !== 'number') continue;
    if (!Number.isFinite(strikes) || !Number.isFinite(articles) || strikes < 0 || strikes > articles) continue;
    out[date] = [strikes, articles];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The per-country GDELT summary (scripts/_gdelt-country-events.mjs), or null
 * when it is missing, malformed, older than CII_GDELT_ESCALATION_MAX_AGE_MS
 * (a stopped materializer must not freeze a spike), or has nothing scoreable.
 * The three readings are gated separately:
 * - escalation (conflict/protest) needs the 21-day baseline and a complete
 *   current window; without them they are null.
 * - the sustained level (week) needs only weekReady: it reads complete days,
 *   so it scores from deploy day, before the baseline has backfilled.
 * - strikes (v12) read only the days the summary lists as measured
 *   (strikeDays); a day missing there is unknown, not quiet.
 */
export function gdeltCountryEventsFromSeed(raw: unknown, nowMs: number): GdeltCountryEvents | null {
  if (!raw || typeof raw !== 'object') return null;
  const { byCountry, baselineReady, currentComplete, weekReady, updatedAt, strikeDays: rawStrikeDays } = raw as Record<string, unknown>;
  if (!byCountry || typeof byCountry !== 'object' || Array.isArray(byCountry)) return null;
  // A current window missing cohorts (materializer outage) is unknown, not calm.
  const escalationReady = baselineReady === true && currentComplete === true;
  const levelReady = weekReady === true;
  const strikeDays = parseGdeltStrikeDays(rawStrikeDays);
  if (!escalationReady && !levelReady && !strikeDays) return null;
  const age = nowMs - safeNum(updatedAt);
  if (!(age <= CII_GDELT_ESCALATION_MAX_AGE_MS)) return null;
  const rows: Record<string, GdeltCountryEventsRow> = {};
  for (const [code, row] of Object.entries(byCountry as Record<string, unknown>)) {
    if (!/^[A-Z]{2}$/.test(code) || !row || typeof row !== 'object') continue;
    const conflict = escalationReady ? parseGdeltEscalationSignal((row as Record<string, unknown>).conflict) : null;
    const protest = escalationReady ? parseGdeltEscalationSignal((row as Record<string, unknown>).protest) : null;
    const week = levelReady ? parseGdeltCountryWeek((row as Record<string, unknown>).week) : null;
    const strikes = strikeDays ? parseGdeltStrikeCounts((row as Record<string, unknown>).strikes, strikeDays) : null;
    if (conflict || protest || week || strikes) rows[code] = { conflict, protest, week, strikes };
  }
  return { byCountry: rows, strikeDays };
}

/** 0..CII_GDELT_ESCALATION_CAP; see the constant's note for the curve and its calibration. */
export function gdeltEscalationScore(signal: GdeltEscalationSignal | undefined | null): number {
  if (!signal || signal.baselineMedian == null) return 0;
  const ratio = (signal.current + CII_GDELT_ESCALATION_SMOOTHING)
    / (signal.baselineMedian + CII_GDELT_ESCALATION_SMOOTHING);
  if (!(ratio > CII_GDELT_ESCALATION_DEADBAND)) return 0;
  const scaled = Math.log(ratio / CII_GDELT_ESCALATION_DEADBAND)
    / Math.log(CII_GDELT_ESCALATION_SATURATION / CII_GDELT_ESCALATION_DEADBAND);
  return Math.round(Math.min(CII_GDELT_ESCALATION_CAP, scaled * CII_GDELT_ESCALATION_CAP));
}

/**
 * 0..CII_GDELT_ESCALATION_CAP from the share of a week's coverage that is
 * conflict- or protest-coded; see CII_GDELT_LEVEL_* for the curve and its calibration.
 */
export function gdeltLevelScore(week: GdeltCountryWeek | undefined | null, field: 'conflict' | 'protest'): number {
  if (!week || !(week.articles >= CII_GDELT_LEVEL_MIN_ARTICLES)) return 0;
  const floor = field === 'conflict' ? CII_GDELT_LEVEL_CONFLICT_FLOOR : CII_GDELT_LEVEL_PROTEST_FLOOR;
  const saturation = field === 'conflict' ? CII_GDELT_LEVEL_CONFLICT_SATURATION : CII_GDELT_LEVEL_PROTEST_SATURATION;
  const scaled = (week[field] / week.articles - floor) / (saturation - floor);
  if (!(scaled > 0)) return 0;
  return Math.round(Math.min(CII_GDELT_ESCALATION_CAP, scaled * CII_GDELT_ESCALATION_CAP));
}

// --- Strike pressure (v12); constants and calibration in ./_risk-config.ts ---

function strikeUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addStrikeDay(target: Record<string, StrikeDays>, code: string, date: string, weight: number): void {
  if (!(weight > 0)) return;
  const days = (target[code] ??= {});
  days[date] = (days[date] ?? 0) + weight;
}

/** [critical, high, elevated, moderate] -> weighted strikes, or null when malformed. */
function strikeTallyWeight(tally: unknown): number | null {
  if (!Array.isArray(tally) || tally.length !== 4) return null;
  if (!tally.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return null;
  const w = CII_STRIKE_SEVERITY_WEIGHTS;
  return tally[0] * w.critical + tally[1] * w.high + tally[2] * w.elevated + tally[3] * w.moderate;
}

/**
 * Weighted confirmed strikes per Tier-1 country and day from the relay's
 * 30-day tally (conflict:strike-pressure:v1), or null when it is missing,
 * malformed or older than CII_STRIKE_CONFIRMED_MAX_AGE_MS (GDELT then carries
 * every country alone). Countries map like every strike input
 * (Gaza to Israel); a non-Tier-1 country scores nowhere.
 */
export function confirmedStrikeDaysFromSeed(raw: unknown, nowMs: number): Record<string, StrikeDays> | null {
  if (!raw || typeof raw !== 'object') return null;
  const { days, updatedAt } = raw as Record<string, unknown>;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return null;
  const age = nowMs - safeNum(updatedAt);
  if (!(safeNum(updatedAt) > 0 && age <= CII_STRIKE_CONFIRMED_MAX_AGE_MS)) return null;
  const out: Record<string, StrikeDays> = {};
  for (const [date, byCountry] of Object.entries(days as Record<string, unknown>)) {
    if (!STRIKE_DATE_RE.test(date) || !byCountry || typeof byCountry !== 'object') continue;
    for (const [iso2, tally] of Object.entries(byCountry as Record<string, unknown>)) {
      const code = ciiCountryForIso2(iso2);
      const weight = strikeTallyWeight(tally);
      if (code && weight !== null) addStrikeDay(out, code, date, weight);
    }
  }
  return out;
}

/**
 * The same weights read straight from the 72h strike window
 * (conflict:iran-events:v1). The 30-day tally is built from these events, so
 * the scorer takes the larger of the two per day: the window covers the tally's
 * first cycles after a deploy, or a relay whose tally write failed.
 */
export function confirmedStrikeDaysFromEvents(events: unknown[], nowMs: number): Record<string, StrikeDays> {
  const out: Record<string, StrikeDays> = {};
  for (const event of Array.isArray(events) ? events : []) {
    const severity = String((event as any)?.severity ?? '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(CII_STRIKE_SEVERITY_WEIGHTS, severity)) continue;
    const ts = (event as any)?.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts > nowMs + DAY_MS) continue;
    const code = strikeEventCountry(event);
    if (code) addStrikeDay(out, code, strikeUtcDay(ts), CII_STRIKE_SEVERITY_WEIGHTS[severity as keyof typeof CII_STRIKE_SEVERITY_WEIGHTS]);
  }
  return out;
}

/**
 * One country's GDELT strike intensity per measured day: the share of its
 * coverage reporting strikes on it, over the noise floor, on the confirmed
 * scale. A day counts only inside a campaign: among the measured days of the
 * seven ending on it, at least CII_STRIKE_GDELT_MIN_MEASURED_DAYS, and over
 * the floor on CII_STRIKE_GDELT_SUSTAINED_DAYS in seven of them (4 of 7 when
 * all are measured). Judged per day, so a campaign keeps decaying after it
 * ends, and unmeasured days neither count for nor against it.
 */
export function gdeltStrikeDays(
  counts: GdeltStrikeCounts | null | undefined,
  strikeDays: Record<string, number> | null | undefined,
  nowMs: number,
): StrikeDays {
  if (!counts || !strikeDays) return {};
  const hits: StrikeDays = {};
  for (const [date, [strikes, articles]] of Object.entries(counts)) {
    if (!Object.prototype.hasOwnProperty.call(strikeDays, date)) continue;
    const share = strikes / (articles + CII_STRIKE_GDELT_SMOOTHING);
    const intensity = CII_STRIKE_GDELT_SCALE * (share - CII_STRIKE_GDELT_NOISE_FLOOR);
    if (intensity > 0) hits[date] = intensity;
  }
  const out: StrikeDays = {};
  for (const [date, intensity] of Object.entries(hits)) {
    const end = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(end) || end > nowMs) continue;
    const week = Array.from({ length: 7 }, (_, i) => strikeUtcDay(end - i * DAY_MS));
    const measured = week.filter((d) => Object.prototype.hasOwnProperty.call(strikeDays, d)).length;
    const struck = week.filter((d) => Object.prototype.hasOwnProperty.call(hits, d)).length;
    if (measured >= CII_STRIKE_GDELT_MIN_MEASURED_DAYS && struck * 7 >= CII_STRIKE_GDELT_SUSTAINED_DAYS * measured) {
      out[date] = intensity;
    }
  }
  return out;
}

/** Per-day maximum of two sources reporting the same strikes. */
function maxStrikeDays(a: StrikeDays | undefined, b: StrikeDays | undefined): StrikeDays {
  const out: StrikeDays = { ...(a ?? {}) };
  for (const [date, value] of Object.entries(b ?? {})) out[date] = Math.max(out[date] ?? 0, value);
  return out;
}

/** P = sum of x_d * 0.5^(age_d / half-life) over the window; age from each day's midpoint. */
export function strikePressure(days: StrikeDays | null | undefined, nowMs: number): number {
  let pressure = 0;
  for (const [date, value] of Object.entries(days ?? {})) {
    if (!STRIKE_DATE_RE.test(date) || !(typeof value === 'number' && value > 0)) continue;
    const start = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(start) || start > nowMs) continue;
    const ageDays = Math.max(0, (nowMs - (start + DAY_MS / 2)) / DAY_MS);
    if (ageDays >= CII_STRIKE_WINDOW_DAYS) continue;
    pressure += value * 0.5 ** (ageDays / CII_STRIKE_HALF_LIFE_DAYS);
  }
  return pressure;
}

export function strikePressureFloor(pressure: number): number {
  if (!(pressure >= CII_STRIKE_FLOOR_MIN_PRESSURE)) return 0;
  return Math.min(
    CII_STRIKE_FLOOR_CAP,
    CII_STRIKE_FLOOR_BASE + CII_STRIKE_FLOOR_PER_DOUBLING * Math.log2(pressure / CII_STRIKE_FLOOR_MIN_PRESSURE),
  );
}

export function strikePressureBoost(pressure: number): number {
  if (!(pressure > 0)) return 0;
  return Math.min(CII_STRIKE_BOOST_CAP, CII_STRIKE_BOOST_PER_DOUBLING * Math.log2(1 + pressure / CII_STRIKE_BOOST_PIVOT));
}

export interface AuxiliarySources {
  ucdpEvents: CiiUcdpRow[];
  /** Events per UTC day across every country, from the UCDP writers; null for a payload without them. */
  ucdpDailyTotals?: Record<string, number> | null;
  /** The UCDP writers' `window.complete`; null for a payload without it. */
  ucdpWriterComplete?: boolean | null;
  /** Months after the newest data whose UCDP release is not published yet (`window.upstreamGapMonths`). */
  ucdpUpstreamGapMonths?: string[];
  outages: any[];
  climate: any[];
  // Detections inside each Tier-1 country, from wildfire:fires-summary:v1
  // (scripts/shared/wildfire-fires-summary.mjs). Null when the summary was
  // present but unscorable.
  fires: Record<string, WildfireFireIntensity[]> | null;
  gpsHexes: any[];
  iranEvents: any[];
  orefData: { activeAlertCount: number; historyCount24h: number } | null;
  advisories: { byCountry: Record<string, 'do-not-travel' | 'reconsider' | 'caution'> } | null;
  // Per-country displaced population by ISO3 code (UNHCR — persists after ceasefires)
  displacedByIso3: Record<string, number>;
  crossBorderSurgeCountries?: string[];
  newsTopStories: NewsTopStory[];
  // Per-country classified headline counts from relay seedClassify() — written to news:threat:summary:v1
  threatSummaryByCountry: Record<string, { critical: number; high: number; medium: number; low: number; info: number }> | null;
  // Phase 1 (CII unification) — additive signal sources, all backed by an existing Redis key.
  aviationAlerts: any[];
  earthquakes: any[];
  sanctionsCountries: any[];
  sanctionsCountryCounts?: Record<string, number> | null;
  temporalAnomalies: any[];
  // Phase 2 (CII unification) — per-country military activity from intelligence:military-cii:v1
  // (written by scripts/seed-military-cii.mjs). Keyed by ISO2.
  militaryCii: Record<string, any> | null;
  // Per-country GDELT conflict and protest volume against each country's own baseline;
  // scored only while ACLED is dark.
  gdeltCountryEvents: GdeltCountryEvents | null;
  // Weighted confirmed strikes per country and day from the relay's 30-day tally
  // (conflict:strike-pressure:v1); null when missing or stale.
  confirmedStrikes?: Record<string, StrikeDays> | null;
  // What each Redis-backed input's read returned, for health only; never scored.
  inputReads?: Partial<Record<CiiInputId, CiiInputRead>>;
}

type NewsTopStory = { countryCode: string | null; countryCodes?: string[]; threatLevel: string; primaryTitle: string };

// Every country a headline names: "Iran-backed Houthis ... after Riyadh airport attack"
// is Saudi news as much as Iranian news. Snapshots written before countryCodes existed
// carry only countryCode.
function newsStoryCountries(story: NewsTopStory): string[] {
  if (story.countryCodes?.length) return story.countryCodes;
  return story.countryCode ? [story.countryCode] : [];
}

const NEWS_THREAT_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  elevated: 1,
  moderate: 0.5,
  low: 0.5,
  info: 0,
};

// Conflict and news. Cyber IOC rows were dropped in v14: they place attacker
// infrastructure, not the country under attack, so they no longer score or count here.
export const CII_REALTIME_REQUIRED_SIGNAL_FAMILY_COUNT = 2;

function emptyAuxiliarySources(): AuxiliarySources {
  return {
    ucdpEvents: [],
    outages: [],
    climate: [],
    fires: {},
    gpsHexes: [],
    iranEvents: [],
    orefData: null,
    advisories: null,
    displacedByIso3: {},
    newsTopStories: [],
    threatSummaryByCountry: null,
    aviationAlerts: [],
    earthquakes: [],
    sanctionsCountries: [],
    sanctionsCountryCounts: null,
    temporalAnomalies: [],
    militaryCii: null,
    gdeltCountryEvents: null,
    confirmedStrikes: null,
  };
}

// Iran-events domain sunset (war ended 2026-07). Default OFF: the strike feed
// no longer contributes to CII/risk scores. Set IRAN_EVENTS_ENABLED=true to
// restore. Mirrors the *_ENABLED env idiom in resilience/v1/_shared.ts.
const IRAN_EVENTS_ENABLED = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';

/** A Redis key the build consumes. `raw` is explicit because seeder keys are bare and app-owned keys are prefixed (#7674). */
interface RiskInput {
  readonly key: string;
  readonly raw: boolean;
  /** Preserve the producer clock for inputs with source-age gates. */
  readonly envelope?: boolean;
}

/** Only the class is kept: a JSON SyntaxError message quotes the stored payload. */
type RiskInputFailureClass = 'timeout' | 'redis' | 'parse';

interface RiskInputReadFailure {
  readonly key: string;
  readonly failure: RiskInputFailureClass;
}

/**
 * Thrown by readRiskInputs when any input read errored, so no payload can be
 * computed from a failed read. getRiskScores' catch serves the stale payload.
 */
export class RiskInputsUnavailableError extends Error {
  constructor(readonly failures: readonly RiskInputReadFailure[]) {
    super(`risk-scores build rejected: ${failures.map((f) => `${f.key}(${f.failure})`).join(', ')}`);
    this.name = 'RiskInputsUnavailableError';
  }
}

function classifyReadFailure(error: unknown): RiskInputFailureClass {
  if (error instanceof SyntaxError) return 'parse';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'redis';
}

/**
 * Reads every input in parallel and resolves positionally: a hit to its value,
 * a genuine miss (or a disabled `null` input) to null. If any read errored it
 * waits for the rest to settle and throws, naming every failed key.
 */
async function readRiskInputs(inputs: ReadonlyArray<RiskInput | null>): Promise<unknown[]> {
  const results = await Promise.all(inputs.map(input => input
    ? (input.envelope ? readCachedEnvelopeJson : readCachedJson)(input.key, input.raw) : null));
  const failures = inputs.flatMap((input, i) => {
    const result = results[i];
    return input && result?.status === 'error' ? [{ key: input.key, failure: classifyReadFailure(result.error) }] : [];
  });
  if (failures.length > 0) throw new RiskInputsUnavailableError(failures);
  return results.map((result) => (result?.status === 'hit' ? result.value : null));
}

async function fetchAuxiliarySources(): Promise<AuxiliarySources> {
  const currentYear = new Date().getFullYear();
  const [ucdpRaw, outagesRaw, climateRaw, firesSummaryRaw, gpsRaw, iranRaw, orefRaw, advisoriesRaw, displacementCurrentRaw, insightsRaw, threatSummaryRaw, aviationRaw, earthquakesRaw, sanctionsRaw, sanctionsCountsRaw, temporalRaw, militaryCiiRaw, countryEventsRaw, strikePressureRaw] = await readRiskInputs([
    { key: 'conflict:ucdp-events:v1', raw: true },
    { key: 'infra:outages:v1', raw: true },
    { key: CLIMATE_ANOMALIES_KEY, raw: true },
    // Per-country intensity rows derived by seed-fire-detections (#9509). The
    // canonical wildfire:fires:v1 is 2-5 MB and used to time out the 1.5 s GET,
    // which rejected the whole build.
    { key: WILDFIRE_FIRES_SUMMARY_KEY, raw: true },
    { key: 'intelligence:gpsjam:v2', raw: true },
    IRAN_EVENTS_ENABLED ? { key: 'conflict:iran-events:v1', raw: true } : null,
    { key: 'relay:oref:history:v1', raw: true },
    { key: 'intelligence:advisories:v1', raw: true },
    { key: `displacement:summary:v1:${currentYear}`, raw: true },
    { key: 'news:insights:v1', raw: true },
    { key: 'news:threat:summary:v1', raw: true },
    // Pre-merged bootstrap (seed-aviation.mjs writes it after merging FAA + intl +
    // NOTAM-synthesized closures). Reading the intl-only key here silently dropped US
    // FAA delays and NOTAM closures from aviationScore.
    { key: 'aviation:delays-bootstrap:v2', raw: true },
    { key: 'seismology:earthquakes:v1', raw: true },
    { key: 'sanctions:pressure:v1', raw: true },
    { key: 'sanctions:country-counts:v1', raw: true },
    // App-owned snapshot (#7674): the temporal-anomalies route stamps
    // temporal:anomalies:v1 through the prefix-aware helpers, so unlike the
    // seeder-owned sources around it this read must ride the deployment
    // prefix — otherwise a preview deployment's risk scores consume the
    // production snapshot instead of the one this deployment rebuilt.
    { key: 'temporal:anomalies:v1', raw: false },
    { key: 'intelligence:military-cii:v1', raw: true },
    // Per-country GDELT conflict/protest counts and baselines (seed-gdelt-bulk-materializer.mjs).
    { key: 'gdelt:bulk:country-events:v1', raw: true },
    // 30-day per-country strike tally built by the relay from the strike feed (v12).
    IRAN_EVENTS_ENABLED ? { key: 'conflict:strike-pressure:v1', raw: true } : null,
  ]);
  // The previous year covers a year not yet seeded. An errored current-year
  // read has already thrown above, so it never masquerades as that.
  const displacementRaw = displacementCurrentRaw
    ?? (await readRiskInputs([{ key: `displacement:summary:v1:${currentYear - 1}`, raw: true }]))[0];
  // The summary is written by the same seeder run as the canonical key, after
  // it. A miss therefore means the reader deployed before the seeder's next
  // tick or that extra-key write failed; recompute the projection from the
  // canonical key then, and only then, so a present-but-unusable summary still
  // surfaces in health instead of hiding behind the fallback. A canonical
  // payload that cannot be summarized is passed through so the parser below
  // reports it unusable rather than missing.
  const firesCanonicalRaw = firesSummaryRaw == null
    ? (await readRiskInputs([{ key: 'wildfire:fires:v1', raw: true }]))[0]
    : null;
  const firesRaw = firesSummaryRaw
    ?? (firesCanonicalRaw == null ? null : summarizeWildfireDetections(firesCanonicalRaw) ?? firesCanonicalRaw);
  const borderSnapshots = await readRiskInputs(CROSS_BORDER_SOURCES.map(source => ({ key: source.key, raw: true, envelope: true })));
  return buildCiiAuxiliarySources({
    ucdp: ucdpRaw,
    outages: outagesRaw,
    climate: climateRaw,
    fires: firesRaw,
    gpsjam: gpsRaw,
    iranEvents: iranRaw,
    oref: orefRaw,
    advisories: advisoriesRaw,
    displacement: displacementRaw,
    newsInsights: insightsRaw,
    threatSummary: threatSummaryRaw,
    aviation: aviationRaw,
    earthquakes: earthquakesRaw,
    sanctionsPressure: sanctionsRaw,
    sanctionsCounts: sanctionsCountsRaw,
    temporalAnomalies: temporalRaw,
    militaryCii: militaryCiiRaw,
    gdeltCountryEvents: countryEventsRaw,
    strikePressure: strikePressureRaw,
    crossBorder: Object.fromEntries(CROSS_BORDER_SOURCES.map((source, i) => [source.id, borderSnapshots[i]])),
  }, Date.now(), { iranEventsEnabled: IRAN_EVENTS_ENABLED });
}

/**
 * Every payload the CII build reads, as the Redis reads return it (null or
 * absent for a miss), keyed by input id rather than Redis key. `fires` is the
 * wildfire summary (or the canonical payload when the summary is missing),
 * `displacement` the current year's summary or else the previous year's, and
 * `crossBorder` each CROSS_BORDER_SOURCES seed envelope by source id.
 * tests/fixtures/cii/ stores captured production inputs in this shape.
 */
export interface CiiRawInputs {
  ucdp?: unknown;
  outages?: unknown;
  climate?: unknown;
  fires?: unknown;
  gpsjam?: unknown;
  iranEvents?: unknown;
  oref?: unknown;
  advisories?: unknown;
  displacement?: unknown;
  newsInsights?: unknown;
  threatSummary?: unknown;
  aviation?: unknown;
  earthquakes?: unknown;
  sanctionsPressure?: unknown;
  sanctionsCounts?: unknown;
  temporalAnomalies?: unknown;
  militaryCii?: unknown;
  gdeltCountryEvents?: unknown;
  strikePressure?: unknown;
  crossBorder?: Record<string, unknown>;
}

export interface CiiAuxiliaryOptions {
  /** IRAN_EVENTS_ENABLED: when false the strike feed and its tally are ignored, as production skips reading them. */
  iranEventsEnabled: boolean;
}

/**
 * Parses raw input payloads into the scorer's sources. Pure: no Redis, no
 * clock and no environment; `nowMs` drives every age gate.
 */
export function buildCiiAuxiliarySources(
  raw: CiiRawInputs,
  nowMs: number,
  options: CiiAuxiliaryOptions,
): AuxiliarySources {
  const { iranEventsEnabled } = options;
  const ucdpRaw = raw.ucdp ?? null;
  const outagesRaw = raw.outages ?? null;
  const climateRaw = raw.climate ?? null;
  const firesRaw = raw.fires ?? null;
  const gpsRaw = raw.gpsjam ?? null;
  const iranRaw = iranEventsEnabled ? raw.iranEvents ?? null : null;
  const orefRaw = raw.oref ?? null;
  const advisoriesRaw = raw.advisories ?? null;
  const displacementRaw = raw.displacement ?? null;
  const insightsRaw = raw.newsInsights ?? null;
  const threatSummaryRaw = raw.threatSummary ?? null;
  const aviationRaw = raw.aviation ?? null;
  const earthquakesRaw = raw.earthquakes ?? null;
  const sanctionsRaw = raw.sanctionsPressure ?? null;
  const sanctionsCountsRaw = raw.sanctionsCounts ?? null;
  const temporalRaw = raw.temporalAnomalies ?? null;
  const militaryCiiRaw = raw.militaryCii ?? null;
  const countryEventsRaw = raw.gdeltCountryEvents ?? null;
  const strikePressureRaw = iranEventsEnabled ? raw.strikePressure ?? null : null;
  const borderSnapshots = CROSS_BORDER_SOURCES.map((source) => raw.crossBorder?.[source.id] ?? null);
  const read = (value: unknown): CiiInputRead => (value == null ? 'missing' : 'present');
  const inputReads: Partial<Record<CiiInputId, CiiInputRead>> = {
    ucdp: read(ucdpRaw),
    outages: read(outagesRaw),
    climate: read(climateRaw),
    fires: read(firesRaw),
    gpsjam: read(gpsRaw),
    iranEvents: iranEventsEnabled ? read(iranRaw) : 'not_configured',
    oref: read(orefRaw),
    advisories: read(advisoriesRaw),
    displacement: read(displacementRaw),
    crossBorder: borderSnapshots.some(snapshot => snapshot != null) ? 'present' : 'missing',
    newsInsights: read(insightsRaw),
    threatSummary: read(threatSummaryRaw),
    aviation: read(aviationRaw),
    earthquakes: read(earthquakesRaw),
    sanctionsPressure: read(sanctionsRaw),
    sanctionsCounts: read(sanctionsCountsRaw),
    militaryCii: read(militaryCiiRaw),
    gdeltCountryEvents: read(countryEventsRaw),
    strikePressure: iranEventsEnabled ? read(strikePressureRaw) : 'not_configured',
  };
  const borderMovements = projectCrossBorderSnapshots(Object.fromEntries(CROSS_BORDER_SOURCES.map((source, i) => [source.id, borderSnapshots[i]])), nowMs).movements;
  const arr = (v: any, field?: string, maxLen = 10000) => {
    let a: any[];
    if (field && v && Array.isArray(v[field])) a = v[field];
    else a = Array.isArray(v) ? v : [];
    return a.length > maxLen ? a.slice(0, maxLen) : a;
  };

  let orefData: AuxiliarySources['orefData'] = null;
  if (orefRaw && typeof orefRaw === 'object') {
    const alertCount = safeNonNegativeNum((orefRaw as any).activeAlertCount);
    const histCount = safeNonNegativeNum((orefRaw as any).historyCount24h);
    orefData = { activeAlertCount: alertCount, historyCount24h: histCount };
  }

  // Build ISO3→totalDisplaced map from UNHCR displacement summary
  const displacedByIso3: Record<string, number> = {};
  const dispCountries: any[] = arr(displacementRaw, 'countries');
  for (const c of dispCountries) {
    const iso3 = String(c.code || '').toUpperCase();
    if (iso3) displacedByIso3[iso3] = safeNonNegativeNum(c.totalDisplaced);
  }
  // Also try nested summary.countries (seed wraps in { summary: { countries: [...] } })
  if (dispCountries.length === 0) {
    const summaryCountries: any[] = arr((displacementRaw as any)?.summary, 'countries');
    for (const c of summaryCountries) {
      const iso3 = String(c.code || '').toUpperCase();
      if (iso3) displacedByIso3[iso3] = safeNonNegativeNum(c.totalDisplaced);
    }
  }

  const rawStories: any[] = insightsRaw && Array.isArray((insightsRaw as any).topStories)
    ? (insightsRaw as any).topStories
    : [];
  const newsTopStories = rawStories.map((s: any) => ({
    countryCode: typeof s.countryCode === 'string' ? s.countryCode : null,
    countryCodes: Array.isArray(s.countryCodes)
      ? s.countryCodes.filter((c: unknown): c is string => typeof c === 'string')
      : [],
    threatLevel: typeof s.threatLevel === 'string' ? s.threatLevel.toLowerCase() : 'low',
    primaryTitle: typeof s.primaryTitle === 'string' ? s.primaryTitle : '',
  }));
  const threatSummaryByCountry: AuxiliarySources['threatSummaryByCountry'] =
    threatSummaryRaw && typeof threatSummaryRaw === 'object' && (threatSummaryRaw as any).byCountry
      ? (threatSummaryRaw as any).byCountry
      : null;
  const sanctionsCountryCounts: Record<string, number> = {};
  if (sanctionsCountsRaw && typeof sanctionsCountsRaw === 'object' && !Array.isArray(sanctionsCountsRaw)) {
    for (const [rawCode, rawCount] of Object.entries(sanctionsCountsRaw as Record<string, unknown>)) {
      const code = String(rawCode || '').toUpperCase();
      const count = safeNonNegativeNum(rawCount);
      if (/^[A-Z]{2}$/.test(code) && count > 0) sanctionsCountryCounts[code] = count;
    }
  }

  const ucdp = parseUcdpCache(ucdpRaw);
  return {
    ucdpEvents: ucdp.rows,
    ucdpDailyTotals: ucdp.dailyTotals,
    ucdpWriterComplete: ucdp.writerComplete,
    ucdpUpstreamGapMonths: ucdp.upstreamGapMonths,
    outages: arr(outagesRaw, 'outages'),
    climate: arr(climateRaw, 'anomalies'),
    fires: parseWildfireFiresSummary(firesRaw)?.byCountry ?? null,
    gpsHexes: arr(gpsRaw, 'hexes'),
    iranEvents: arr(iranRaw, 'events'),
    orefData,
    advisories: advisoriesRaw && typeof advisoriesRaw === 'object' && (advisoriesRaw as any).byCountry
      ? { byCountry: (advisoriesRaw as any).byCountry }
      : null,
    displacedByIso3,
    crossBorderSurgeCountries: borderMovements
      .filter(m => m.kind === 'arrival' && m.surge && !m.stale)
      .flatMap(m => [m.countryCode, m.originCode]).filter(Boolean),
    newsTopStories,
    threatSummaryByCountry,
    aviationAlerts: arr(aviationRaw, 'alerts'),
    earthquakes: arr(earthquakesRaw, 'earthquakes'),
    sanctionsCountries: arr(sanctionsRaw, 'countries'),
    sanctionsCountryCounts: Object.keys(sanctionsCountryCounts).length > 0 ? sanctionsCountryCounts : null,
    temporalAnomalies: arr(temporalRaw, 'anomalies'),
    militaryCii: militaryCiiRaw && typeof militaryCiiRaw === 'object' && (militaryCiiRaw as any).byCountry
      ? (militaryCiiRaw as any).byCountry
      : null,
    gdeltCountryEvents: gdeltCountryEventsFromSeed(countryEventsRaw, nowMs),
    confirmedStrikes: confirmedStrikeDaysFromSeed(strikePressureRaw, nowMs),
    inputReads,
  };
}

// ========================================================================
// Input availability (health)
// ------------------------------------------------------------------------
// ACLED credentials went missing around 2026-07 (#5134) and Unrest and
// Conflict read 0 everywhere for months without any health signal. Each build
// therefore reports every scored input's availability on its seed-meta;
// api/_cii-input-health.js owns the verdict and must list the same ids.
// temporal:anomalies:v1 is read but not scored (its producer emits only
// region 'global'), so it is not reported.
// ========================================================================

export const CII_HEALTH_INPUT_IDS = [
  'acled', 'ucdp', 'gdeltCountryEvents', 'iranEvents', 'strikePressure', 'oref',
  'outages', 'climate', 'fires', 'gpsjam', 'advisories', 'displacement',
  'crossBorder', 'newsInsights', 'threatSummary', 'aviation', 'earthquakes',
  'sanctionsPressure', 'sanctionsCounts', 'militaryCii',
] as const;
export type CiiInputId = typeof CII_HEALTH_INPUT_IDS[number];
type CiiInputRead = 'present' | 'missing' | 'not_configured';
export type CiiInputState = 'live' | 'quiet' | 'missing' | 'unusable' | 'not_configured';
export interface CiiInputReport {
  state: CiiInputState;
  quietSince?: number;
  /** The window the cached rows cover, for inputs whose term assumes one (UCDP, P9). */
  window?: CiiUcdpWindow;
}
/** Read-time window checks, by input: what the cache covers against what the term assumes (P9). */
export type CiiInputWindows = Partial<Record<CiiInputId, CiiUcdpWindow>>;

export function assessCiiInputWindows(aux: AuxiliarySources, nowMs: number): CiiInputWindows {
  return aux.inputReads?.ucdp === 'present'
    ? { ucdp: assessUcdpWindow(aux.ucdpEvents, aux.ucdpDailyTotals, nowMs, aux.ucdpWriterComplete ?? null, aux.ucdpUpstreamGapMonths ?? []) }
    : {};
}

const CII_INPUT_AUX_FIELD: Record<Exclude<CiiInputId, 'acled'>, keyof AuxiliarySources> = {
  ucdp: 'ucdpEvents',
  gdeltCountryEvents: 'gdeltCountryEvents',
  iranEvents: 'iranEvents',
  strikePressure: 'confirmedStrikes',
  oref: 'orefData',
  outages: 'outages',
  climate: 'climate',
  fires: 'fires',
  gpsjam: 'gpsHexes',
  advisories: 'advisories',
  displacement: 'displacedByIso3',
  crossBorder: 'crossBorderSurgeCountries',
  newsInsights: 'newsTopStories',
  threatSummary: 'threatSummaryByCountry',
  aviation: 'aviationAlerts',
  earthquakes: 'earthquakes',
  sanctionsPressure: 'sanctionsCountries',
  sanctionsCounts: 'sanctionsCountryCounts',
  militaryCii: 'militaryCii',
};

// Parsers that return null when they reject a present payload: past their own
// age gate (GDELT 6h, strike tally 72h) or without the field they score.
const CII_INPUT_REJECTED_AS_NULL = new Set<CiiInputId>([
  'gdeltCountryEvents', 'strikePressure', 'oref', 'advisories', 'threatSummary', 'militaryCii', 'fires',
]);

/**
 * Classifies each scored input for health. An input is `live` when it moves
 * at least one Tier-1 score on its own: the scorer runs once per input against
 * an otherwise empty build and the result is compared with the all-empty
 * build. This reuses computeCIIScores as-is, so it follows any formula change
 * and measures exactly "zero across all Tier-1 countries". A standby input
 * (GDELT while ACLED is live) is still graded on what it would contribute.
 * An input whose whole effect lands under a score floor (UCDP, advisory)
 * reads quiet; the quiet budgets in api/_cii-input-health.js are set only for
 * feeds that move unfloored countries every day.
 */
export function assessCiiInputAvailability(
  acled: Array<{ country: string; event_type: string; fatalities: number; daysAgo?: number }>,
  aux: AuxiliarySources,
  nowMs: number,
  acledConfigured = isAcledConfigured(),
): Record<CiiInputId, CiiInputState> {
  const fingerprint = (rows: typeof acled, sources: AuxiliarySources) => JSON.stringify(computeCIIScores(rows, sources, { nowMs }));
  const baseline = fingerprint([], emptyAuxiliarySources());
  const states = {
    acled: !acledConfigured ? 'not_configured' : fingerprint(acled, emptyAuxiliarySources()) !== baseline ? 'live' : 'quiet',
  } as Record<CiiInputId, CiiInputState>;
  for (const [id, field] of Object.entries(CII_INPUT_AUX_FIELD) as Array<[Exclude<CiiInputId, 'acled'>, keyof AuxiliarySources]>) {
    const read = aux.inputReads?.[id] ?? 'missing';
    if (read !== 'present') {
      states[id] = read;
    } else if (aux[field] == null && CII_INPUT_REJECTED_AS_NULL.has(id)) {
      states[id] = 'unusable';
    } else {
      states[id] = fingerprint([], { ...emptyAuxiliarySources(), [field]: aux[field] }) !== baseline ? 'live' : 'quiet';
    }
  }
  return states;
}

/**
 * Attaches `quietSince`, carried from the previous report while the input
 * stays quiet, and each input's read-time window check.
 */
export function withCiiInputQuietClocks(
  states: Record<CiiInputId, CiiInputState>,
  previousInputs: unknown,
  nowMs: number,
  windows: CiiInputWindows = {},
): Record<CiiInputId, CiiInputReport> {
  const previous = previousInputs && typeof previousInputs === 'object'
    ? previousInputs as Record<string, Partial<CiiInputReport> | undefined>
    : {};
  const reports = {} as Record<CiiInputId, CiiInputReport>;
  for (const id of CII_HEALTH_INPUT_IDS) {
    const state = states[id];
    const window = windows[id] ? { window: windows[id] } : {};
    if (state !== 'quiet') {
      reports[id] = { state, ...window };
      continue;
    }
    const since = previous[id]?.state === 'quiet' ? Number(previous[id]?.quietSince) : NaN;
    reports[id] = { state, quietSince: Number.isFinite(since) && since > 0 && since <= nowMs ? since : nowMs, ...window };
  }
  return reports;
}

/** Every term behind one country's score, as computeCIIScores combined them. */
export interface CiiCountryTerms {
  baseline: number;
  eventMultiplier: number;
  components: { unrest: number; conflict: number; security: number; information: number };
  /** The parts of each component, before its cap and rounding. */
  parts: {
    unrestBase: number; unrestFatalityBoost: number; unrestSeverityBoost: number; outageBoost: number; gdeltUnrest: number;
    acledScore: number; fatalityScore: number; civilianBoost: number; orefBoost: number; gdeltConflict: number; ucdpViolence: number;
    flightScore: number; vesselScore: number; aviationScore: number; gpsJammingScore: number;
    newsScore: number; threatSummaryScore: number;
  };
  eventScore: number;
  boosts: {
    climate: number; fire: number; advisory: number; orefBlend: number; displacement: number; crossBorder: number;
    newsUrgency: number; earthquake: number; sanctions: number; ais: number; strikePressure: number;
  };
  /** baseline and eventScore weighted, plus every boost: the score before floors, rounding and the cap. */
  blended: number;
  floors: { advisory: number; strike: number };
  /** The largest floor candidate; it binds when it exceeds the rounded blend. */
  floor: number;
  strikePressure: number;
  /** UCDP organised violence, decay-weighted deaths per million people per year. */
  ucdpRate: number;
  combinedScore: number;
}

export function computeCIIScores(
  acled: Array<{ country: string; event_type: string; fatalities: number; daysAgo?: number }>,
  aux: AuxiliarySources,
  trendOptions: CiiTrendComparisonOptions = {},
  termsSink?: Record<string, CiiCountryTerms>,
): CiiScore[] {
  const computedAt = Number.isFinite(trendOptions.nowMs) ? Number(trendOptions.nowMs) : Date.now();
  const priorByRegion = buildPriorCiiScoreMap(trendOptions.priorScores);
  const data: Record<string, CountrySignals> = {};
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    data[code] = emptySignals();
    const liveLevel = isAdvisoryLevel(aux.advisories?.byCountry?.[code])
      ? aux.advisories.byCountry[code]
      : null;
    const fallbackLevel = advisoryFallbackLevel(code);
    data[code].advisoryLevel = liveLevel || fallbackLevel;
    data[code].advisoryProvenance = liveLevel ? 'live' : fallbackLevel ? 'fallback' : 'absent';
  }

  // --- Displacement ingestion (UNHCR — persists after ceasefires) ---
  for (const [iso3, totalDisplaced] of Object.entries(aux.displacedByIso3 ?? {})) {
    const iso2 = ISO3_TO_ISO2[iso3];
    if (iso2 && data[iso2]) {
      data[iso2].totalDisplaced = Math.max(data[iso2].totalDisplaced, totalDisplaced);
    }
  }

  // --- ACLED ingestion with fatality split and time decay ---
  // Events 0-7 days old: weight 1.0 (full impact)
  // Events 8-30 days old: weight 0.4 (partial — captures post-ceasefire/post-conflict tail)
  for (const ev of acled) {
    const code = normalizeCountryName(ev.country);
    if (!code || !data[code]) continue;
    const type = ev.event_type.toLowerCase();
    const weight = (ev.daysAgo ?? 0) <= 7 ? 1.0 : 0.4;
    const fatalities = safeNonNegativeNum(ev.fatalities);
    const fat = fatalities * weight;
    if (type.includes('protest')) {
      data[code].protests += weight;
      data[code].protestFatalities += fat;
      // High-severity = the event killed someone (classifySeverity rule).
      if (fatalities > 0) data[code].highSeverityUnrest += weight;
    } else if (type.includes('riot')) {
      data[code].riots += weight;
      data[code].protestFatalities += fat;
      // A riot is always high-severity (classifySeverity rule).
      data[code].highSeverityUnrest += weight;
    } else if (type.includes('battle')) {
      data[code].battles += weight;
      data[code].conflictFatalities += fat;
    } else if (type.includes('explosion') || type.includes('remote')) {
      data[code].explosions += weight;
      data[code].conflictFatalities += fat;
    } else if (type.includes('violence')) {
      data[code].civilianViolence += weight;
      data[code].conflictFatalities += fat;
    }
    data[code].fatalities += fat;
  }

  // --- GDELT conflict and protest escalation (only while ACLED is dark) ---
  if (acled.length === 0) {
    for (const [code, row] of Object.entries(aux.gdeltCountryEvents?.byCountry ?? {})) {
      if (!data[code]) continue;
      // One signal read two ways (a spike over the norm, or a sustained level):
      // the larger counts, never the sum.
      data[code].gdeltConflictEscalation = Math.max(
        gdeltEscalationScore(row.conflict),
        gdeltLevelScore(row.week, 'conflict'),
      );
      data[code].gdeltUnrestEscalation = Math.max(
        gdeltEscalationScore(row.protest),
        gdeltLevelScore(row.week, 'protest'),
      );
    }
  }

  // --- UCDP organised violence (v15): decayed deaths per capita, scored inside Conflict ---
  for (const [code, rate] of Object.entries(ucdpViolenceRates(aux.ucdpEvents, computedAt))) {
    if (data[code]) data[code].ucdpRate = rate;
  }

  // --- Outages (string enum severity) ---
  for (const o of aux.outages) {
    const code = (o.countryCode || o.country_code || '').toUpperCase();
    if (!data[code]) continue;
    const sev = String(o.severity || '').toUpperCase();
    if (sev.includes('TOTAL') || sev === 'NATIONWIDE') data[code].outageTotalCount++;
    else if (sev.includes('MAJOR') || sev === 'REGIONAL') data[code].outageMajorCount++;
    else if (sev.includes('PARTIAL') || sev.includes('LOCAL') || sev.includes('MINOR')) data[code].outagePartialCount++;
  }

  // --- Climate ---
  for (const a of aux.climate) {
    const severity = climateSeverityScore(a.severity ?? a.score);
    for (const code of climateCountriesForAnomaly(a)) {
      if (data[code]) data[code].climateSeverity = Math.max(data[code].climateSeverity, severity);
    }
  }

  // Cyber IOC feeds (AbuseIPDB, Feodo, URLhaus, C2Intel, OTX) are not read since v14:
  // each row's country is where the malicious IP or URL is hosted, not the victim, so
  // they scored datacenter countries (US, GB, DE, FR) instead of countries under attack.

  // --- Fires --- (already attributed to Tier-1 countries by the summary producer)
  for (const [code, fires] of Object.entries(aux.fires ?? {})) {
    if (!data[code]) continue;
    for (const f of fires) {
      data[code].fireCount++;
      // "High" fire — bright or high radiative power (Phase 3b / D8, matches the frontend).
      if (safeNonNegativeNum(f.brightness) >= 360 || safeNonNegativeNum(f.frp) >= 50) data[code].fireHighCount++;
    }
  }

  // --- GPS hex severity split ---
  for (const h of aux.gpsHexes) {
    const lat = safeNum(h.lat || h.latitude);
    const lon = safeNum(h.lon || h.longitude);
    const code = geoToCountry(lat, lon);
    if (!code || !data[code]) continue;
    if (h.level === 'high') data[code].gpsHighCount++;
    else data[code].gpsMediumCount++;
  }

  // --- Aviation disruptions (Phase 1 — gathered, not yet scored) ---
  // country is a name; delayType/severity may be lowercase or proto-enum form
  // (FLIGHT_DELAY_TYPE_CLOSURE / FLIGHT_DELAY_SEVERITY_SEVERE) — substring match handles both.
  for (const a of aux.aviationAlerts ?? []) {
    const code = normalizeCountryName(String(a.country || ''));
    if (!code || !data[code]) continue;
    const dt = String(a.delayType || '').toLowerCase();
    const sev = String(a.severity || '').toLowerCase();
    if (dt.includes('closure')) data[code].aviationClosureCount++;
    else if (sev.includes('severe')) data[code].aviationSevereCount++;
    else if (sev.includes('major')) data[code].aviationMajorCount++;
    else if (sev.includes('moderate')) data[code].aviationModerateCount++;
  }

  // --- Earthquakes (Phase 1) — magnitude >= 5.5, within 7-day lookback ---
  const eqCutoff = computedAt - 7 * 24 * 60 * 60 * 1000;
  for (const eq of aux.earthquakes ?? []) {
    const mag = safeNonNegativeNum(eq.magnitude);
    if (mag < 5.5) continue;
    if (safeNum(eq.occurredAt) < eqCutoff) continue;
    const code = earthquakeCountry(eq);
    if (!code || !data[code]) continue;
    if (mag >= 7.5) data[code].earthquakeSevereCount++;
    else if (mag >= 6.5) data[code].earthquakeMajorCount++;
    else data[code].earthquakeSignificantCount++;
  }

  // --- Sanctions pressure (Phase 1) — direct ISO2 attribution ---
  // Prefer the full ISO2→entryCount map because the pressure payload's `countries`
  // array is intentionally a top-pressure display summary.
  const fullSanctionsCounts = aux.sanctionsCountryCounts ?? null;
  for (const [rawCode, rawCount] of Object.entries(fullSanctionsCounts ?? {})) {
    const code = String(rawCode || '').toUpperCase();
    if (!data[code]) continue;
    data[code].sanctionsEntryCount = safeNonNegativeNum(rawCount);
  }
  for (const c of aux.sanctionsCountries ?? []) {
    const code = String(c.countryCode || '').toUpperCase();
    if (!data[code]) continue;
    // Accumulate (not assign): the producer keys per-country rows by `code:name`, so one
    // ISO2 can appear in multiple rows when the source spells the name differently.
    if (!fullSanctionsCounts || !Object.prototype.hasOwnProperty.call(fullSanctionsCounts, code)) {
      data[code].sanctionsEntryCount += safeNonNegativeNum(c.entryCount);
    }
    data[code].sanctionsNewEntryCount += safeNonNegativeNum(c.newEntryCount);
  }

  // --- Temporal anomalies (Phase 1) — region is ISO2 or country name; skip 'global' ---
  for (const an of aux.temporalAnomalies ?? []) {
    const region = String(an.region || '').trim();
    if (!region || region.toLowerCase() === 'global') continue;
    const code = data[region.toUpperCase()] ? region.toUpperCase() : normalizeCountryName(region);
    if (!code || !data[code]) continue;
    data[code].temporalAnomalyCount++;
    if (String(an.severity || '').toLowerCase() === 'critical') data[code].temporalAnomalyCriticalCount++;
  }

  // --- Military activity (Phase 2) — per-country aggregate from intelligence:military-cii:v1 ---
  // Own counts are gathered but not scored since v14 (see the Security score below).
  for (const [code, m] of Object.entries(aux.militaryCii ?? {})) {
    const d = data[code];
    if (!d || !m || typeof m !== 'object') continue;
    d.militaryOwnFlights = safeNonNegativeNum((m as any).ownFlights);
    d.militaryForeignFlights = safeNonNegativeNum((m as any).foreignFlights);
    d.militaryOwnVessels = safeNonNegativeNum((m as any).ownVessels);
    d.militaryForeignVessels = safeNonNegativeNum((m as any).foreignVessels);
    d.aisDisruptionHighCount = safeNonNegativeNum((m as any).aisDisruptionHigh);
    d.aisDisruptionElevatedCount = safeNonNegativeNum((m as any).aisDisruptionElevated);
    d.aisDisruptionLowCount = safeNonNegativeNum((m as any).aisDisruptionLow);
  }

  // --- Strike pressure (v12): confirmed feed and GDELT, per day the larger, decayed ---
  // The 72h window and the 30-day tally carry the same events (max per day);
  // GDELT strikes stand in only while ACLED is dark, like the other GDELT terms.
  const confirmedStrikes = Object.entries(confirmedStrikeDaysFromEvents(aux.iranEvents, computedAt))
    .reduce<Record<string, StrikeDays>>((out, [code, days]) => {
      out[code] = maxStrikeDays(out[code], days);
      return out;
    }, { ...(aux.confirmedStrikes ?? {}) });
  const gdeltStrikes = acled.length === 0 ? aux.gdeltCountryEvents : null;
  for (const code of Object.keys(data)) {
    const gdelt = gdeltStrikeDays(gdeltStrikes?.byCountry?.[code]?.strikes, gdeltStrikes?.strikeDays, computedAt);
    data[code]!.strikePressure = strikePressure(maxStrikeDays(confirmedStrikes[code], gdelt), computedAt);
  }

  // --- OREF (IL only) ---
  if (aux.orefData && data.IL) {
    data.IL.orefAlertCount = aux.orefData.activeAlertCount;
    data.IL.orefHistoryCount24h = aux.orefData.historyCount24h;
  }

  // --- News insights threat scoring ---
  for (const story of aux.newsTopStories) {
    const weight = NEWS_THREAT_WEIGHT[story.threatLevel] ?? 0;
    if (weight === 0) continue;
    const tracked = newsStoryCountries(story).filter((code) => data[code]);
    if (tracked.length === 0) {
      const titleCode = normalizeCountryName(story.primaryTitle);
      if (titleCode && data[titleCode]) tracked.push(titleCode);
    }
    for (const code of tracked) data[code]!.newsScore += weight;
  }

  // --- News threat summary (from relay seedClassify — all classified headlines) ---
  if (aux.threatSummaryByCountry) {
    const SUMMARY_WEIGHT: Record<string, number> = { critical: 4, high: 2, medium: 1, low: 0.5, info: 0 };
    for (const [code, counts] of Object.entries(aux.threatSummaryByCountry)) {
      const signals = data[code];
      if (!signals) continue;
      let score = 0;
      for (const [lvl, w] of Object.entries(SUMMARY_WEIGHT)) {
        score += safeNonNegativeNum(counts[lvl as keyof typeof counts]) * w;
      }
      signals.threatSummaryScore = Math.min(20, score);
    }
  }

  // --- Scoring ---
  const scores: CiiScore[] = [];
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    const d = data[code]!;
    const baseline = BASELINE_RISK[code] ?? DEFAULT_CII_BASELINE_RISK;
    const multiplier = EVENT_MULTIPLIER[code] ?? DEFAULT_CII_EVENT_MULTIPLIER;

    // --- Unrest score (ported from frontend calcUnrestScore) ---
    const unrestCount = d.protests + d.riots;
    const adjustedCount = multiplier < 0.7
      ? Math.log2(unrestCount + 1) * multiplier * 5
      : unrestCount * multiplier;
    const unrestBase = Math.min(50, adjustedCount * 8);
    const unrestFatalityBoost = Math.min(30, d.protestFatalities * 5 * multiplier);
    // severityBoost (Phase 3b / C1) — ported from the frontend calcUnrestScore.
    const unrestSeverityBoost = Math.min(20, d.highSeverityUnrest * 10 * multiplier);
    const outageBoost = Math.min(50, d.outageTotalCount * 30 + d.outageMajorCount * 15 + d.outagePartialCount * 5);
    const unrest = Math.min(100, Math.round(
      unrestBase + unrestFatalityBoost + unrestSeverityBoost + outageBoost + d.gdeltUnrestEscalation,
    ));

    // --- Conflict score (ported from frontend calcConflictScore) ---
    const conflictActivityRaw = (d.battles * 3 + d.explosions * 4 + d.civilianViolence * 5) * multiplier;
    const acledScore = Math.round(logScaledScore(
      conflictActivityRaw,
      CII_CONFLICT_ACTIVITY_CAP,
      CII_CONFLICT_ACTIVITY_PIVOT,
    ));
    const fatalityScore = Math.min(40, Math.round(Math.sqrt(d.conflictFatalities) * 5 * multiplier));
    const civilianBoost = Math.min(10, d.civilianViolence * 3);
    const orefBoost = (code === 'IL' && d.orefAlertCount > 0)
      ? 25 + Math.min(25, d.orefAlertCount * 5)
      : 0;
    const ucdpViolence = ucdpViolenceScore(d.ucdpRate);
    // One violence family: ACLED, GDELT conflict coverage and UCDP deaths report
    // the same war, so they merge by max, never by sum (brief, P6). OREF rocket
    // alerts are a separate signal and add on top.
    const conflict = Math.min(
      100,
      Math.max(acledScore + fatalityScore + civilianBoost, d.gdeltConflictEscalation, ucdpViolence) + orefBoost,
    );

    // --- Security score (Phase 3b / decision C3 — full 4-input calcSecurityScore) ---
    // Flights + vessels + aviation + GPS. Military presence counts only FOREIGN aircraft
    // and vessels located in the country, weighted ×2 as before. Since v14 a country's own
    // air force and navy score nothing: own counts follow the operator anywhere in the
    // world, so routine training (RAF/French sorties took GB 9 → 31, FR 9 → 25 overnight)
    // and own vessels saturated Security for GB/FR/DE/US every day.
    const milFlights = d.militaryForeignFlights * 2;
    const milVessels = d.militaryForeignVessels * 2;
    const flightScore = Math.min(50, milFlights * 3);
    const vesselScore = Math.min(30, milVessels * 5);
    const aviationScore = Math.min(
      40,
      d.aviationClosureCount * 20 + d.aviationSevereCount * 15
        + d.aviationMajorCount * 10 + d.aviationModerateCount * 5,
    );
    const gpsJammingScore = Math.min(35, d.gpsHighCount * 5 + d.gpsMediumCount * 2);
    const security = Math.min(100, Math.round(flightScore + vesselScore + aviationScore + gpsJammingScore));

    // information cap raised 20 → 100 to match unrest/conflict/security ranges.
    // Previous cap silently limited information's max contribution to 5 points
    // (20 × 0.25) vs 25 for any other component despite the equal 0.25 weight.
    // Issue #3739.
    const information = Math.min(100, d.newsScore + d.threatSummaryScore);

    const eventScore = unrest * 0.25 + conflict * 0.30 + security * 0.20 + information * 0.25;

    const climateBoost = Math.min(15, d.climateSeverity * 3);
    // fire (Phase 3b / D8) — severity-weighted. (The cyber boost beside it was removed in v14.)
    const fireBoost = Math.min(8, d.fireHighCount * 1.5 + Math.min(20, d.fireCount) * 0.25);

    // --- Advisory boost ---
    const advisoryBoost = d.advisoryLevel === 'do-not-travel' ? 15
      : d.advisoryLevel === 'reconsider' ? 10
      : d.advisoryLevel === 'caution' ? 5 : 0;

    // --- OREF blend boost (IL only) ---
    const orefBlendBoost = code === 'IL'
      ? (d.orefAlertCount > 0 ? 15 : 0) + (d.orefHistoryCount24h >= 10 ? 10 : d.orefHistoryCount24h >= 3 ? 5 : 0)
      : 0;

    // --- Displacement boost (UNHCR — persists after ceasefires) ---
    // Ramp anchored so the scale spans meaningful crisis sizes:
    //   100K  → +4  |  500K → +10  |  1M → +12  |  5M → +18  |  10M+ → +20
    // Formula: (log10(n) - 5) * 8 + 4, clamped [0, 20].
    // Below ~32K displaced → 0; cap reached at 10M.
    const displacementBoost = d.totalDisplaced > 0
      ? Math.min(20, Math.max(0, Math.round((Math.log10(d.totalDisplaced) - 5) * 8 + 4)))
      : 0;

    // --- Phase 3b blend reconciliation (decisions D2/D4/D5/D6) ---
    // newsUrgencyBoost (D2): pure function of the information component.
    const newsUrgencyBoost = information >= 70 ? 5 : information >= 50 ? 3 : 0;
    // earthquakeBoost (D5): ported verbatim from the frontend getEarthquakeBoost.
    const earthquakeBoost = Math.min(
      25,
      d.earthquakeSevereCount * 10 + d.earthquakeMajorCount * 5 + d.earthquakeSignificantCount * 2,
    );
    // sanctionsBoost (D6): ported verbatim from the frontend getSanctionsBoost.
    let sanctionsBoost = 0;
    if (d.sanctionsEntryCount > 0) {
      sanctionsBoost = d.sanctionsEntryCount >= 2000 ? 12
        : d.sanctionsEntryCount >= 501 ? 8
        : d.sanctionsEntryCount >= 101 ? 5 : 3;
      if (d.sanctionsNewEntryCount > 0) sanctionsBoost += 2;
    }
    // supplementalSignalBoost (D4): the frontend's helper summed AIS + fire + cyber +
    // temporal. AIS is its own blend term below; fire is the severity-weighted
    // term above; cyber was removed in v14. The temporal sub-boost is NOT wired — the temporal:anomalies:v1
    // producer (list-temporal-anomalies.ts) emits every anomaly with region:'global', so
    // they cannot be country-attributed. `temporalAnomaly*Count` stay gathered-not-scored
    // (Phase 1 intent); re-wire a temporalBoost only if the producer emits country-scoped
    // anomalies. The frontend's temporal sub-boost has the same dormancy for the same reason.
    const aisBoost = Math.min(
      10,
      d.aisDisruptionHighCount * 2.5 + d.aisDisruptionElevatedCount * 1.5 + d.aisDisruptionLowCount * 0.5,
    );

    // Assigned inside the sum so termsSink reports it without restating its constant.
    let crossBorderBoost: number;
    const blended = baseline * 0.4
      + eventScore * 0.6
      + climateBoost
      + fireBoost
      + advisoryBoost
      + orefBlendBoost
      + displacementBoost
      + (crossBorderBoost = aux.crossBorderSurgeCountries?.includes(code) ? 5 : 0)
      + newsUrgencyBoost
      + earthquakeBoost
      + sanctionsBoost
      + aisBoost
      // Strike pressure (v12), capped; replaces the 72h strikeBoost inside Conflict.
      + strikePressureBoost(d.strikePressure);

    // --- Floors (v15 removed the UCDP class floors: UCDP scores inside Conflict) ---
    const advisoryFloor = d.advisoryLevel === 'do-not-travel' ? 60
      : d.advisoryLevel === 'reconsider' ? 50 : 0;
    const strikeFloor = Math.round(strikePressureFloor(d.strikePressure));
    const floor = Math.max(advisoryFloor, strikeFloor);

    const composite = Math.min(100, Math.max(floor, Math.round(blended)));
    const { dynamicScore, trend } = deriveCiiTrendDelta(composite, priorByRegion.get(code), computedAt);
    if (termsSink) {
      termsSink[code] = {
        baseline,
        eventMultiplier: multiplier,
        components: { unrest, conflict, security, information },
        parts: {
          unrestBase, unrestFatalityBoost, unrestSeverityBoost, outageBoost, gdeltUnrest: d.gdeltUnrestEscalation,
          acledScore, fatalityScore, civilianBoost, orefBoost, gdeltConflict: d.gdeltConflictEscalation, ucdpViolence,
          flightScore, vesselScore, aviationScore, gpsJammingScore,
          newsScore: d.newsScore, threatSummaryScore: d.threatSummaryScore,
        },
        eventScore,
        boosts: {
          climate: climateBoost, fire: fireBoost, advisory: advisoryBoost, orefBlend: orefBlendBoost,
          displacement: displacementBoost, crossBorder: crossBorderBoost, newsUrgency: newsUrgencyBoost,
          earthquake: earthquakeBoost, sanctions: sanctionsBoost, ais: aisBoost,
          strikePressure: strikePressureBoost(d.strikePressure),
        },
        blended,
        floors: { advisory: advisoryFloor, strike: strikeFloor },
        floor,
        strikePressure: d.strikePressure,
        ucdpRate: d.ucdpRate,
        combinedScore: composite,
      };
    }

    scores.push({
      region: code,
      staticBaseline: baseline,
      // Back-compat field name: clients already read dynamicScore as the
      // recent score movement. With no valid prior snapshot, emit a flat
      // cold-start delta instead of the structural baseline gap.
      dynamicScore,
      combinedScore: composite,
      trend,
      components: {
        newsActivity: information,
        ciiContribution: unrest,
        geoConvergence: conflict,
        militaryActivity: security,
      },
      computedAt,
      // Disclosure fields (issue #3725) — make the editorial weights and
      // formula version visible on the wire so API clients can detect drift.
      // See docs/methodology/cii-risk-scores.mdx.
      eventMultiplier: multiplier,
      methodologyVersion: CII_FORMULA_VERSION,
      // Advisory levels can boost/floor CII scores. Keep the level and its
      // source visible so clients know whether the input was live, embedded
      // fallback, or absent for the country.
      advisoryLevel: d.advisoryLevel ?? '',
      advisoryProvenance: d.advisoryProvenance,
    });
  }

  scores.sort((a, b) => b.combinedScore - a.combinedScore);
  return scores;
}

// ========================================================================
// Scoring seam
// ------------------------------------------------------------------------
// The whole score table from explicit inputs and a clock value, with every
// term. Production builds call the same code (fetchAuxiliarySources ->
// buildCiiAuxiliarySources, then computeCIIScores), so the fixtures in
// tests/fixtures/cii/, scripts/cii-table-diff.mts and
// tests/cii-invariants.test.mts measure the deployed formula. See
// docs/methodology/cii-change-brief.md before changing any score.
// ========================================================================

export type CiiFloorName = keyof CiiCountryTerms['floors'];

export interface CiiScoreTableRow extends CiiCountryTerms {
  region: string;
  /** Floors equal to the binding value when it exceeds the rounded blend; empty when the blend set the score. */
  bindingFloors: CiiFloorName[];
}

export interface CiiScoreTable {
  /** Exactly what computeCIIScores returns: sorted by combinedScore, descending. */
  scores: CiiScore[];
  /** One row per country, in the order of `scores`. */
  rows: CiiScoreTableRow[];
  aux: AuxiliarySources;
}

export interface CiiScoreOptions {
  nowMs: number;
  /** ACLED rows; production has had none since 2026-07 (no ACLED access). */
  acledEvents?: Array<{ country: string; event_type: string; fatalities: number; daysAgo?: number }>;
  priorScores?: CiiScore[] | null;
}

/** Scores already-parsed sources. Pure. */
export function scoreCiiAuxiliarySources(aux: AuxiliarySources, options: CiiScoreOptions): CiiScoreTable {
  const terms: Record<string, CiiCountryTerms> = {};
  const scores = computeCIIScores(options.acledEvents ?? [], aux, { nowMs: options.nowMs, priorScores: options.priorScores }, terms);
  const rows = scores.map((score): CiiScoreTableRow => {
    const t = terms[score.region]!;
    const binds = t.floor > Math.round(t.blended);
    const bindingFloors = binds
      ? (Object.keys(t.floors) as CiiFloorName[]).filter((name) => t.floors[name] === t.floor)
      : [];
    return { region: score.region, ...t, bindingFloors };
  });
  return { scores, rows, aux };
}

/**
 * The scoring seam: the full CII table from raw input payloads and `nowMs`.
 * Pure: no Redis, no clock, no environment. IRAN_EVENTS_ENABLED and ACLED
 * rows are parameters.
 */
export function computeCiiScoreTable(
  raw: CiiRawInputs,
  options: CiiScoreOptions & CiiAuxiliaryOptions,
): CiiScoreTable {
  const aux = buildCiiAuxiliarySources(raw, options.nowMs, { iranEventsEnabled: options.iranEventsEnabled });
  return scoreCiiAuxiliarySources(aux, options);
}

export function computeStrategicRisks(ciiScores: CiiScore[]): StrategicRisk[] {
  // Editorial roll-up: see ./_risk-config.ts and
  // docs/methodology/cii-risk-scores.mdx for rationale and band derivation.
  const topN = ciiScores.slice(0, STRATEGIC_RISK_TOP_N);
  const weights = topN.map((_, i) => 1 - i * STRATEGIC_RISK_POSITIONAL_DECAY);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const weightedSum = topN.reduce((sum, s, i) => sum + s.combinedScore * weights[i]!, 0);
  const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const overallScore = Math.min(
    100,
    Math.round(weightedAvg * STRATEGIC_RISK_SCALE_FACTOR + STRATEGIC_RISK_SCALE_FLOOR),
  );

  return [
    {
      region: 'global',
      level: (overallScore >= 70
        ? 'SEVERITY_LEVEL_HIGH'
        : overallScore >= 40
          ? 'SEVERITY_LEVEL_MEDIUM'
          : 'SEVERITY_LEVEL_LOW') as SeverityLevel,
      score: overallScore,
      factors: topN.map((s) => s.region),
      // The global roll-up is never compared with a prior roll-up, so there is
      // no measured direction to report.
      trend: 'TREND_DIRECTION_UNSPECIFIED' as TrendDirection,
    },
  ];
}

export function normalizeRiskScoreRegion(region: string | undefined | null): string | null {
  const normalized = String(region || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function hasRiskScoreRegionFilter(region: string | undefined | null): boolean {
  return String(region || '').trim() !== '';
}

function isTier1CountryCode(code: string | undefined | null): boolean {
  return Object.prototype.hasOwnProperty.call(TIER1_COUNTRIES, String(code || '').trim().toUpperCase());
}

export function countCiiRealtimeSignalDensityCoverage(
  acled: Array<{ country: string; event_type: string; fatalities: number; daysAgo?: number }> | undefined | null,
  aux: AuxiliarySources | undefined | null,
  nowMs = Date.now(),
): number {
  // Health semantics: this is signal-density coverage for score-relevant
  // realtime families, not a raw feed heartbeat. Quiet-but-available feeds may
  // produce 0 here; underlying feed freshness is monitored by their own
  // seed-meta/TTL health entries where available.
  const coveredFamilies = new Set<'conflict' | 'news'>();

  // Conflict family: satisfied by EITHER the ACLED API path OR the UCDP aux feed.
  // ACLED is only one of two live conflict sources both consumed by computeCIIScores —
  // when the ACLED API path returns empty (rate-limit/auth/quiet window), the rich
  // `conflict:ucdp-events:v1` feed (15+ Tier-1 countries) still drives the score floor,
  // so the conflict signal is genuinely alive and must count toward health coverage.
  // Requiring ACLED specifically here flipped /api/health.riskScores to COVERAGE_PARTIAL
  // whenever ACLED was thin even though UCDP was fully healthy.
  const acledCoversTier1 = (acled ?? []).some((ev) => isTier1CountryCode(normalizeCountryName(ev.country)));
  const ucdpCoversTier1 = Object.values(ucdpViolenceRates(aux?.ucdpEvents, nowMs)).some((rate) => ucdpViolenceScore(rate) > 0);
  // GDELT stands in for ACLED only while the ACLED path is empty, as in computeCIIScores.
  const gdeltCoversTier1 = !(acled ?? []).length
    && Object.keys(aux?.gdeltCountryEvents?.byCountry ?? {}).some(isTier1CountryCode);
  if (acledCoversTier1 || ucdpCoversTier1 || gdeltCoversTier1) {
    coveredFamilies.add('conflict');
  }

  for (const story of aux?.newsTopStories ?? []) {
    const weight = NEWS_THREAT_WEIGHT[String(story.threatLevel || '').toLowerCase()] ?? 0;
    if (weight <= 0) continue;
    if (
      newsStoryCountries(story).some(isTier1CountryCode)
      || isTier1CountryCode(normalizeCountryName(story.primaryTitle))
    ) {
      coveredFamilies.add('news');
      break;
    }
  }

  if (!coveredFamilies.has('news')) {
    for (const [code, counts] of Object.entries(aux?.threatSummaryByCountry ?? {})) {
      if (!isTier1CountryCode(code)) continue;
      const weightedCount = Object.entries(NEWS_THREAT_WEIGHT).reduce(
        (sum, [level, weight]) => sum + safeNonNegativeNum(counts[level as keyof typeof counts]) * weight,
        0,
      );
      if (weightedCount > 0) {
        coveredFamilies.add('news');
        break;
      }
    }
  }

  return coveredFamilies.size;
}

function withRiskScoreRuntimeState(
  response: GetRiskScoresResponse,
  state: Pick<GetRiskScoresResponse, 'degraded' | 'stale'>,
): GetRiskScoresResponse {
  return { ...response, degraded: state.degraded, stale: state.stale };
}

export function hasCompleteRiskScoreAdvisoryDisclosure(response: GetRiskScoresResponse): boolean {
  return (response.ciiScores ?? []).every((score) => (
    isAdvisoryLevelOrEmpty(score.advisoryLevel)
    && isAdvisoryProvenance(score.advisoryProvenance)
  ));
}

export function normalizeRiskScoreAdvisoryDisclosure(response: GetRiskScoresResponse): GetRiskScoresResponse {
  return {
    ...response,
    ciiScores: (response.ciiScores ?? []).map((score) => {
      if (
        isAdvisoryLevelOrEmpty(score.advisoryLevel)
        && isAdvisoryProvenance(score.advisoryProvenance)
      ) {
        return score;
      }

      const fallbackLevel = advisoryFallbackLevel(score.region);
      return {
        ...score,
        advisoryLevel: fallbackLevel ?? '',
        advisoryProvenance: fallbackLevel ? 'fallback' : 'absent',
      };
    }),
  };
}

export function filterRiskScoresResponse(
  response: GetRiskScoresResponse,
  region: string | undefined | null,
): GetRiskScoresResponse {
  if (!hasRiskScoreRegionFilter(region)) return response;
  const normalizedRegion = normalizeRiskScoreRegion(region);
  if (!normalizedRegion) return { ...response, ciiScores: [], strategicRisks: [] };

  return {
    ...response,
    ciiScores: response.ciiScores.filter((score) => score.region.toUpperCase() === normalizedRegion),
    // StrategicRisk is currently a global top-N roll-up. Recomputing it over a
    // single filtered country would still label the result "global", so a
    // region-filtered response only returns region-specific strategic risks if
    // such risks are added later.
    strategicRisks: response.strategicRisks.filter((risk) => risk.region.toUpperCase() === normalizedRegion),
  };
}

// ========================================================================
// Cache keys
// ========================================================================

// Payload key family is bumped when CII_FORMULA_VERSION changes so old
// methodology payloads cannot survive deploy via Redis. Bump propagated to
// every reader: get-country-risk.ts, chat-analyst-context.ts,
// brief-story-context.ts, server/_shared/cache-keys.ts, api/bootstrap.js,
// api/health.js, api/mcp/registry/cache-tools.ts, scripts/seed-cross-source-signals.mjs,
// scripts/seed-forecasts.mjs, scripts/regional-snapshot/*. The seed-meta key
// (`seed-meta:intelligence:risk-scores`) is unchanged — that's freshness tracking,
// not the payload itself.
// Daily history deliberately lives outside the versioned sebuf family. Each
// member carries its methodology so a formula bump preserves the old series.
const RISK_CACHE_KEY = `risk:scores:sebuf:${CII_FORMULA_VERSION}`;
const RISK_STALE_CACHE_KEY = `risk:scores:sebuf:stale:${CII_FORMULA_VERSION}`;
const RISK_TREND_HISTORY_CACHE_KEY_PREFIX = `risk:scores:sebuf:trend-history:${CII_FORMULA_VERSION}`;
// Latest rejected build, for operators: function logs do not survive in prod.
const RISK_REJECTED_BUILD_KEY = `risk:scores:sebuf:rejected:${CII_FORMULA_VERSION}`;
// `region` is deliberately excluded from the Redis key: this endpoint caches
// the all-country payload once and applies any region filter as a read-only
// projection at return time, so per-region requests cannot poison global cache.
const RISK_CACHE_TTL = 600;
const RISK_STALE_TTL = 3600;
const CII_TREND_HISTORY_TTL = 3 * 24 * 60 * 60;
const RISK_REJECTED_BUILD_TTL = 7 * 24 * 60 * 60;

export function getCiiTrendHistoryBucket(capturedAtMs: number): number {
  const capturedAt = finiteNumber(capturedAtMs);
  return capturedAt === null ? 0 : Math.floor(capturedAt / CII_TREND_BUCKET_MS);
}

function ciiTrendHistoryCacheKey(bucket: number): string {
  return `${RISK_TREND_HISTORY_CACHE_KEY_PREFIX}:${bucket}`;
}

export function getCiiTrendPriorCandidateBuckets(nowMs: number): number[] {
  const targetBucket = getCiiTrendHistoryBucket(nowMs - CII_TREND_TARGET_AGE_MS);
  const buckets = [targetBucket];
  for (let offset = 1; offset <= CII_TREND_BUCKET_LOOKUP_RADIUS; offset += 1) {
    buckets.push(targetBucket - offset, targetBucket + offset);
  }
  return buckets;
}

function isCiiTrendSnapshot(value: unknown): value is CiiTrendSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<CiiTrendSnapshot>;
  return finiteNumber(snapshot.capturedAt) !== null
    && Array.isArray(snapshot.ciiScores)
    && snapshot.ciiScores.length > 0;
}

export function selectCiiTrendPriorSnapshot(
  snapshots: Array<CiiTrendSnapshot | null | undefined>,
  nowMs: number,
): CiiTrendSnapshot | null {
  let selected: CiiTrendSnapshot | null = null;
  let selectedDistance = Number.POSITIVE_INFINITY;
  let selectedCapturedAt = Number.NEGATIVE_INFINITY;

  for (const snapshot of snapshots) {
    if (!isCiiTrendSnapshot(snapshot)) continue;
    const capturedAt = finiteNumber(snapshot.capturedAt);
    if (capturedAt === null || capturedAt <= 0 || capturedAt > nowMs) continue;

    const ageMs = nowMs - capturedAt;
    if (ageMs < CII_TREND_PRIOR_MIN_AGE_MS || ageMs > CII_TREND_PRIOR_MAX_AGE_MS) continue;

    const distance = Math.abs(ageMs - CII_TREND_TARGET_AGE_MS);
    if (distance < selectedDistance || (distance === selectedDistance && capturedAt > selectedCapturedAt)) {
      selected = snapshot;
      selectedDistance = distance;
      selectedCapturedAt = capturedAt;
    }
  }

  return selected;
}

function ciiTrendSnapshotFromResponse(response: GetRiskScoresResponse): CiiTrendSnapshot | null {
  let latestComputedAt = Number.NEGATIVE_INFINITY;
  for (const score of response.ciiScores ?? []) {
    const computedAt = finiteNumber(score.computedAt);
    if (computedAt !== null && computedAt > latestComputedAt) latestComputedAt = computedAt;
  }

  if (!Number.isFinite(latestComputedAt) || latestComputedAt <= 0 || !response.ciiScores?.length) return null;
  return { capturedAt: latestComputedAt, ciiScores: response.ciiScores };
}

// Not a readRiskInputs input: the prior only sets movement labels, and a
// missing prior already degrades to "stable". getCachedJson logs an errored
// bucket and treats it as absent.
async function readCiiTrendPriorScores(nowMs: number): Promise<CiiScore[] | null> {
  const snapshots = await Promise.all(
    getCiiTrendPriorCandidateBuckets(nowMs).map(async (bucket) => {
      const value = await getCachedJson(ciiTrendHistoryCacheKey(bucket));
      return isCiiTrendSnapshot(value) ? value : null;
    }),
  );
  return selectCiiTrendPriorSnapshot(snapshots, nowMs)?.ciiScores ?? null;
}

const CII_TREND_PRIOR_GAP_LOG_THROTTLE_MS = 10 * 60 * 1000;
let lastCiiTrendPriorGapLogAt = 0;

function recordCiiTrendPriorGap(nowMs: number): void {
  if (nowMs - lastCiiTrendPriorGapLogAt < CII_TREND_PRIOR_GAP_LOG_THROTTLE_MS) return;
  lastCiiTrendPriorGapLogAt = nowMs;
  console.info('[cii] trend prior unavailable; returning stable movement labels until 24h trend history is populated', {
    nowMs,
    candidateBuckets: getCiiTrendPriorCandidateBuckets(nowMs),
    targetAgeMs: CII_TREND_TARGET_AGE_MS,
    bucketMs: CII_TREND_BUCKET_MS,
  });
}

async function persistCiiTrendSnapshot(response: GetRiskScoresResponse): Promise<void> {
  const snapshot = ciiTrendSnapshotFromResponse(response);
  if (!snapshot) return;

  await setCachedJson(
    ciiTrendHistoryCacheKey(getCiiTrendHistoryBucket(snapshot.capturedAt)),
    snapshot,
    CII_TREND_HISTORY_TTL,
  );
}

// Replacement and the heartbeat must be atomic. A plain pipeline can interleave
// two ZREM/ZADD pairs or stamp health after a failed country write.
const CII_DAILY_WRITE_LUA = `
local count = #KEYS - 3
local day = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local captured = tonumber(ARGV[3])
for i, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local expected = i <= count and 'zset' or 'string'
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('cii_history_wrong_type') end
end
local previous = redis.call('GET', KEYS[count + 2])
if previous and tonumber(cjson.decode(previous).fetchedAt) > captured then return 0 end
for i = 1, count do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], day, day)
  redis.call('ZADD', KEYS[i], day, ARGV[5 + i])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', day - 365)
  redis.call('EXPIRE', KEYS[i], ttl)
end
redis.call('SET', KEYS[count + 1], ARGV[4], 'EX', ttl)
redis.call('SET', KEYS[count + 2], ARGV[5], 'EX', ttl + 86400)
redis.call('SET', KEYS[count + 3], captured)
return count
`;

export async function persistCiiDailyHistory(response: GetRiskScoresResponse): Promise<void> {
  if (response.stale || response.degraded || response.ciiScores.length !== CII_COUNTRY_CODES.length) return;
  const scores = new Map(response.ciiScores.map(score => [score.region, score]));
  const members = CII_COUNTRY_CODES.map(code => {
    const score = scores.get(code);
    return JSON.stringify({
      d: score?.computedAt ? new Date(score.computedAt).toISOString().slice(0, 10) : '',
      v: score?.methodologyVersion, s: score?.combinedScore,
      u: score?.components?.ciiContribution, c: score?.components?.geoConvergence,
      m: score?.components?.militaryActivity, n: score?.components?.newsActivity, t: score?.computedAt,
    });
  });
  const capturedAt = Math.max(...response.ciiScores.map(score => score.computedAt));
  if (!Number.isFinite(capturedAt) || parseCiiDailyPoints(members, capturedAt).invalid
    || response.ciiScores.some(score => score.computedAt !== capturedAt)) return;
  const keys = CII_RISK_SCORE_CACHE_KEYS;
  const results = await runRedisPipeline([[
    'EVAL', CII_DAILY_WRITE_LUA, CII_COUNTRY_CODES.length + 3,
    ...CII_COUNTRY_CODES.map(code => `${keys.dailyHistoryPrefix}${code}`), keys.dailyHistoryIndex, keys.dailyHistoryMeta, keys.dailyHistoryActivation,
    Math.floor(capturedAt / CII_DAY_MS), 400 * 86400, capturedAt,
    JSON.stringify({ date: new Date(capturedAt).toISOString().slice(0, 10), methodologyVersion: response.ciiScores[0]!.methodologyVersion, countries: CII_COUNTRY_CODES }),
    JSON.stringify({ fetchedAt: capturedAt, recordCount: CII_COUNTRY_CODES.length }), ...members,
  ]]);
  if (results.length !== 1 || results[0]?.error) console.warn('[cii] daily history write unconfirmed');
}

/**
 * Awaited because a serverless runtime may drop a promise still pending after
 * the response; it runs only on the rejection path and never throws.
 */
async function recordRejectedRiskScoresBuild(err: RiskInputsUnavailableError): Promise<void> {
  console.error('[cii] risk-scores build rejected; input reads failed', { failedReads: err.failures });
  await setCachedJson(
    RISK_REJECTED_BUILD_KEY,
    { at: Date.now(), failedReads: err.failures },
    RISK_REJECTED_BUILD_TTL,
  ).catch(() => undefined);
}

async function buildRiskScoresPayload(): Promise<{
  response: GetRiskScoresResponse;
  realtimeSignalDensityCoverageCount: number;
  ciiInputs: Record<CiiInputId, CiiInputState>;
  ciiInputWindows: CiiInputWindows;
}> {
  const nowMs = Date.now();
  const [acled, aux, priorCiiScores] = await Promise.all([
    fetchACLEDEvents(),
    fetchAuxiliarySources(),
    readCiiTrendPriorScores(nowMs),
  ]).catch(async (err: unknown) => {
    if (err instanceof RiskInputsUnavailableError) await recordRejectedRiskScoresBuild(err);
    throw err;
  });
  if (!priorCiiScores?.length) recordCiiTrendPriorGap(nowMs);
  const realtimeSignalDensityCoverageCount = countCiiRealtimeSignalDensityCoverage(acled, aux, nowMs);
  const ciiScores = computeCIIScores(acled, aux, { priorScores: priorCiiScores, nowMs });
  const strategicRisks = computeStrategicRisks(ciiScores);
  return {
    response: { ciiScores, strategicRisks, degraded: false, stale: false },
    realtimeSignalDensityCoverageCount,
    ciiInputs: assessCiiInputAvailability(acled, aux, nowMs),
    ciiInputWindows: assessCiiInputWindows(aux, nowMs),
  };
}

const RISK_SEED_META_KEY = 'seed-meta:intelligence:risk-scores';

async function persistFreshRiskScorePayload(
  freshResult: GetRiskScoresResponse,
  realtimeSignalDensityCoverageCount: number,
  ciiInputs: Record<CiiInputId, CiiInputState> | null,
  ciiInputWindows: CiiInputWindows,
  options: { liveCache?: boolean } = {},
): Promise<void> {
  const fetchedAt = Date.now();
  // The previous report carries each quiet input's clock. An unreadable one
  // restarts the clocks, which can only delay a quiet-too-long verdict.
  const previousMeta = ciiInputs ? await getCachedJson(RISK_SEED_META_KEY).catch(() => null) : null;
  const inputs = ciiInputs
    ? withCiiInputQuietClocks(ciiInputs, (previousMeta as { inputs?: unknown } | null)?.inputs, fetchedAt, ciiInputWindows)
    : undefined;
  const writes: Array<Promise<unknown>> = [
    setCachedJson(RISK_STALE_CACHE_KEY, freshResult, RISK_STALE_TTL),
    persistCiiTrendSnapshot(freshResult),
    persistCiiDailyHistory(freshResult),
    setCachedJson(
      RISK_SEED_META_KEY,
      { fetchedAt, recordCount: realtimeSignalDensityCoverageCount, ...(inputs ? { inputs } : {}) },
      604800,
    ),
  ];

  if (options.liveCache) writes.unshift(setCachedJson(RISK_CACHE_KEY, freshResult, RISK_CACHE_TTL));
  await Promise.all(writes.map((write) => write.catch(() => undefined)));
}

// ========================================================================
// RPC handler
// ========================================================================

export async function getRiskScores(
  _ctx: ServerContext,
  req: GetRiskScoresRequest,
): Promise<GetRiskScoresResponse> {
  try {
    let realtimeSignalDensityCoverageCount = 0;
    let ciiInputs: Record<CiiInputId, CiiInputState> | null = null;
    let ciiInputWindows: CiiInputWindows = {};
    const { data: result, source, leader } = await cachedFetchJsonWithMeta<GetRiskScoresResponse>(
      RISK_CACHE_KEY,
      RISK_CACHE_TTL,
      async () => {
        const built = await buildRiskScoresPayload();
        realtimeSignalDensityCoverageCount = built.realtimeSignalDensityCoverageCount;
        ciiInputs = built.ciiInputs;
        ciiInputWindows = built.ciiInputWindows;
        return built.response;
      },
      undefined,
      // A rejected build must leave RISK_CACHE_KEY untouched: no NEG_SENTINEL,
      // only the helper's short isolate-local backoff before the next rebuild.
      { cacheFetcherErrors: false },
    );
    if (result) {
      let freshResult = withRiskScoreRuntimeState(result, { degraded: false, stale: false });
      let liveCacheBackfill = false;
      if (!hasCompleteRiskScoreAdvisoryDisclosure(freshResult)) {
        try {
          const built = await buildRiskScoresPayload();
          realtimeSignalDensityCoverageCount = built.realtimeSignalDensityCoverageCount;
          ciiInputs = built.ciiInputs;
          ciiInputWindows = built.ciiInputWindows;
          freshResult = withRiskScoreRuntimeState(built.response, { degraded: false, stale: false });
          liveCacheBackfill = true;
        } catch {
          freshResult = withRiskScoreRuntimeState(normalizeRiskScoreAdvisoryDisclosure(freshResult), {
            degraded: false,
            stale: false,
          });
        }
      }
      // Write stale fallback, trend history, and seed-meta on every FRESH upstream
      // fetch by the true in-process leader so /api/health.riskScores
      // stays green from real user traffic, independent of the ais-relay
      // CII warm-ping. Pre-2026-05-02 the warm-ping was the SOLE writer of
      // this seed-meta — when the relay → api.worldmonitor.app auth path
      // broke (all warm-ping types started returning HTTP 401 simultaneously),
      // riskScores was the only key that flipped STALE because cable-health
      // and chokepoints had RPC-side seed-meta writes keeping them fresh
      // via real user traffic. This brings riskScores into the same pattern
      // as those two: defense-in-depth, no single point of freshness failure.
      //
      // Gated on source === 'fresh' && leader (PR #3562 review P2 + CII P3
      // runtime polish): cachedFetchJsonWithMeta returns immediately on cache
      // hits with `source: 'cache'`, and concurrent followers of the same miss
      // get `leader: false`. Stamping
      // `fetchedAt: Date.now()` on cache hits would conflate "data was
      // recently re-fetched" with "data was recently served," letting
      // health.riskScores stay fresh even when upstream stopped responding
      // (cache would be served until its TTL=600s expired, after which the
      // first request triggers a fresh fetch and surfaces the failure
      // properly — but only if seed-meta wasn't already advanced by a cache
      // hit). Only stamp on actual upstream re-fetches.
      // 7-day TTL matches the warm-ping write so health.maxStaleMin (30min)
      // logic is unchanged.
      if ((source === 'fresh' && leader) || liveCacheBackfill) {
        await persistFreshRiskScorePayload(freshResult, realtimeSignalDensityCoverageCount, ciiInputs, ciiInputWindows, {
          liveCache: liveCacheBackfill,
        });
      }
      return filterRiskScoresResponse(freshResult, req.region);
    }
  } catch { /* upstream failed, fall through to stale */ }

  const stale = (await getCachedJson(RISK_STALE_CACHE_KEY)) as GetRiskScoresResponse | null;
  if (stale) {
    return filterRiskScoresResponse(
      withRiskScoreRuntimeState(normalizeRiskScoreAdvisoryDisclosure(stale), { degraded: true, stale: true }),
      req.region,
    );
  }
  const ciiScores = computeCIIScores([], emptyAuxiliarySources());
  return filterRiskScoresResponse(
    { ciiScores, strategicRisks: computeStrategicRisks(ciiScores), degraded: true, stale: false },
    req.region,
  );
}
