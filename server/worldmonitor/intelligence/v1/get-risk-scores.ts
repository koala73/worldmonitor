import type {
  ServerContext,
  GetRiskScoresRequest,
  GetRiskScoresResponse,
  CiiScore,
  StrategicRisk,
  TrendDirection,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import iso3ToIso2Json from '../../../../shared/iso3-to-iso2.json';
import { getCachedJson, setCachedJson, cachedFetchJsonWithMeta } from '../../../_shared/redis';
import { CLIMATE_ANOMALIES_KEY } from '../../../_shared/cache-keys';
import { TIER1_COUNTRIES } from './_shared';
import { fetchAcledCached } from '../../../_shared/acled';
import {
  CII_CONFLICT_ACTIVITY_CAP,
  CII_CONFLICT_ACTIVITY_PIVOT,
  CII_FORMULA_VERSION,
  STRATEGIC_RISK_POSITIONAL_DECAY,
  STRATEGIC_RISK_SCALE_FACTOR,
  STRATEGIC_RISK_SCALE_FLOOR,
  STRATEGIC_RISK_TOP_N,
} from './_risk-config';
import {
  CII_BASELINE_RISK,
  CII_EVENT_MULTIPLIER,
  DEFAULT_CII_BASELINE_RISK,
  DEFAULT_CII_EVENT_MULTIPLIER,
} from '../../../../shared/cii-weights';

// ========================================================================
// Country risk baselines and multipliers
// ------------------------------------------------------------------------
// Editorial values — see docs/methodology/cii-risk-scores.mdx for the
// published table and the rationale. The authoritative coefficient table
// lives in shared/cii-weights.ts so browser-side scoring and server-side
// scoring cannot drift.
//
// Change protocol when editing coefficient values in shared/cii-weights.ts:
//   1. Bump CII_FORMULA_VERSION in ./_risk-config.ts if server/API scores shift.
//   2. Update docs/methodology/cii-risk-scores.mdx in the SAME commit.
//   3. Mention the change in CHANGELOG.md (public-facing section).
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

// Exported so the seed-military-cii.mjs drift-guard test can assert its re-embedded copy
// stays in sync (scripts/ cannot import from server/ at runtime, but tests can).
export const COUNTRY_BBOX: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number }> = {
  US: { minLat: 24.5, maxLat: 49.4, minLon: -125.0, maxLon: -66.9 },
  RU: { minLat: 41.2, maxLat: 81.9, minLon: 19.6, maxLon: 180.0 },
  CN: { minLat: 18.2, maxLat: 53.6, minLon: 73.5, maxLon: 135.1 },
  UA: { minLat: 44.4, maxLat: 52.4, minLon: 22.1, maxLon: 40.2 },
  IR: { minLat: 25.1, maxLat: 39.8, minLon: 44.0, maxLon: 63.3 },
  IL: { minLat: 29.5, maxLat: 33.3, minLon: 34.3, maxLon: 35.9 },
  TW: { minLat: 21.9, maxLat: 25.3, minLon: 120.0, maxLon: 122.0 },
  KP: { minLat: 37.7, maxLat: 43.0, minLon: 124.3, maxLon: 130.7 },
  SA: { minLat: 16.4, maxLat: 32.2, minLon: 34.6, maxLon: 55.7 },
  TR: { minLat: 36.0, maxLat: 42.1, minLon: 26.0, maxLon: 44.8 },
  PL: { minLat: 49.0, maxLat: 54.8, minLon: 14.1, maxLon: 24.2 },
  DE: { minLat: 47.3, maxLat: 55.1, minLon: 5.9, maxLon: 15.0 },
  FR: { minLat: 41.4, maxLat: 51.1, minLon: -5.1, maxLon: 9.6 },
  GB: { minLat: 49.9, maxLat: 60.9, minLon: -8.2, maxLon: 1.8 },
  IN: { minLat: 6.7, maxLat: 35.5, minLon: 68.1, maxLon: 97.4 },
  PK: { minLat: 23.7, maxLat: 37.1, minLon: 60.9, maxLon: 77.8 },
  SY: { minLat: 32.3, maxLat: 37.3, minLon: 35.7, maxLon: 42.4 },
  YE: { minLat: 12.1, maxLat: 19.0, minLon: 42.5, maxLon: 54.5 },
  MM: { minLat: 9.8, maxLat: 28.5, minLon: 92.2, maxLon: 101.2 },
  VE: { minLat: 0.6, maxLat: 12.2, minLon: -73.4, maxLon: -59.8 },
  CU: { minLat: 19.8, maxLat: 23.3, minLon: -85.0, maxLon: -74.1 },
  MX: { minLat: 14.5, maxLat: 32.7, minLon: -118.4, maxLon: -86.7 },
  BR: { minLat: -33.7, maxLat: 5.3, minLon: -73.9, maxLon: -34.8 },
  AE: { minLat: 22.6, maxLat: 26.1, minLon: 51.6, maxLon: 56.4 },
  KR: { minLat: 33.1, maxLat: 38.6, minLon: 125.1, maxLon: 131.9 },
  IQ: { minLat: 29.1, maxLat: 37.4, minLon: 38.8, maxLon: 48.6 },
  AF: { minLat: 29.4, maxLat: 38.5, minLon: 60.5, maxLon: 75.0 },
  LB: { minLat: 33.1, maxLat: 34.7, minLon: 35.1, maxLon: 36.6 },
  EG: { minLat: 22.0, maxLat: 31.7, minLon: 24.7, maxLon: 36.9 },
  JP: { minLat: 24.4, maxLat: 45.5, minLon: 122.9, maxLon: 153.0 },
  QA: { minLat: 24.5, maxLat: 26.2, minLon: 50.7, maxLon: 51.7 },
};

export const ZONE_COUNTRY_MAP: Record<string, string[]> = {
  'North America': ['US'], 'Europe': ['DE', 'FR', 'GB', 'PL', 'TR', 'UA'],
  'East Asia': ['CN', 'TW', 'KP', 'KR', 'JP'], 'South Asia': ['IN', 'PK', 'MM', 'AF'],
  'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE', 'AE', 'IQ', 'LB', 'QA'], 'Russia': ['RU'],
  'Latin America': ['VE', 'CU', 'MX', 'BR'], 'North Africa': ['EG'],
  Ukraine: ['UA'],
  California: ['US'],
  Amazon: ['BR'],
  'Taiwan Strait': ['TW', 'CN'],
  Myanmar: ['MM'],
  Caribbean: ['CU', 'MX'],
  Mediterranean: ['TR', 'IL', 'SY', 'LB', 'EG'],
  Arctic: ['RU'],
  'Tibetan Plateau': ['CN', 'IN'],
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

const BBOX_BY_AREA = Object.entries(COUNTRY_BBOX)
  .map(([code, b]) => ({ code, ...b, area: (b.maxLat - b.minLat) * (b.maxLon - b.minLon) }))
  .sort((a, b) => a.area - b.area);

type CountryBBoxCandidate = (typeof BBOX_BY_AREA)[number];

function isInsideBBox(b: CountryBBoxCandidate, lat: number, lon: number): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

function isNorthOfApproxUsMxBorder(lat: number, lon: number): boolean {
  // Coarse segmented US/MX border approximation inside the shared bbox overlap.
  if (lon <= -114.70) return lat >= 32.53; // California / Baja California
  if (lon <= -111.05) return lat >= 31.33; // Arizona / Sonora
  if (lon <= -106.45) return lat >= 31.73; // New Mexico / Chihuahua

  const rioGrandeChord: Array<[number, number]> = [
    [-106.45, 31.73], // El Paso / Ciudad Juarez
    [-104.40, 29.60], // Big Bend / Ojinaga
    [-100.95, 29.37], // Del Rio / Ciudad Acuna
    [-100.50, 28.72], // Eagle Pass / Piedras Negras
    [-99.50, 27.50],  // Laredo / Nuevo Laredo
    [-98.20, 26.22],  // McAllen / Reynosa
    [-97.50, 25.89],  // Brownsville / Matamoros
  ];
  for (let i = 1; i < rioGrandeChord.length; i++) {
    const [prevLon, prevLat] = rioGrandeChord[i - 1]!;
    const [nextLon, nextLat] = rioGrandeChord[i]!;
    if (lon <= nextLon) {
      const progress = (lon - prevLon) / (nextLon - prevLon);
      const borderLat = prevLat + progress * (nextLat - prevLat);
      return lat >= borderLat;
    }
  }
  const borderLat = 25.89;
  return lat >= borderLat;
}

function isWestOfApproxPlUaBorder(lat: number, lon: number): boolean {
  const border: Array<[number, number]> = [
    [22.70, 49.05], // Bieszczady / Zakarpattia
    [23.05, 50.05], // Przemysl / Lviv corridor
    [23.65, 51.50], // Bug River north of Lublin
  ];
  if (lat <= border[0]![1]) return lon <= border[0]![0];
  for (let i = 1; i < border.length; i++) {
    const [prevLon, prevLat] = border[i - 1]!;
    const [nextLon, nextLat] = border[i]!;
    if (lat <= nextLat) {
      const progress = (lat - prevLat) / (nextLat - prevLat);
      const borderLon = prevLon + progress * (nextLon - prevLon);
      return lon <= borderLon;
    }
  }
  return lon <= border[border.length - 1]![0];
}

function isKnownNonTier1BBoxGap(lat: number, lon: number, candidates: CountryBBoxCandidate[]): boolean {
  // Jordan is not a Tier-1 CII country. Its rectangle overlaps Saudi Arabia's
  // broad bbox; fail closed only when SA is the sole tracked-country candidate.
  // If a tighter Tier-1 bbox also matches, keep the normal attribution path.
  return candidates.length === 1
    && candidates[0]!.code === 'SA'
    && lat >= 30.8
    && lat <= 32.6
    && lon >= 35.4
    && lon <= 37.4;
}

function resolveKnownBBoxOverlap(lat: number, lon: number, candidates: CountryBBoxCandidate[]): string | null {
  const codes = new Set(candidates.map((candidate) => candidate.code));

  if (codes.has('KP') && codes.has('CN') && codes.has('RU') && lat < 42.5) return 'KP';
  if (codes.has('PL') && codes.has('UA')) return isWestOfApproxPlUaBorder(lat, lon) ? 'PL' : 'UA';
  if (codes.has('CN') && codes.has('IN') && lat >= 28.5 && lat <= 32.0 && lon >= 89.0 && lon <= 93.5) return 'CN';
  if (codes.has('TR') && codes.has('SY') && lat >= 36.6 && lat <= 37.6 && lon >= 36.0 && lon <= 38.8) return 'TR';
  if (codes.has('IR') && codes.has('IQ') && lat >= 33.4 && lat <= 35.2 && lon >= 45.5 && lon <= 48.6) return 'IR';
  if (codes.has('PK') && codes.has('AF') && lat >= 29.4 && lat <= 31.5 && lon >= 65.0 && lon <= 68.2) return 'PK';
  if (codes.has('SA') && codes.has('EG') && lat >= 27.5 && lat <= 29.6 && lon >= 35.0 && lon <= 37.1) return 'SA';
  if (codes.has('SA') && codes.has('IR') && lat >= 25.0 && lat <= 27.8 && lon >= 48.0 && lon <= 51.5) return 'SA';
  if (codes.has('CN') && codes.has('MM') && lat >= 23.5 && lat <= 25.0 && lon >= 97.3 && lon <= 98.4) return 'CN';
  if (codes.has('CN') && codes.has('RU') && lat >= 50.5 && lat <= 51.5 && lon >= 127.8 && lon <= 129.6) return 'RU';

  if (codes.has('US') && codes.has('MX')) {
    return isNorthOfApproxUsMxBorder(lat, lon) ? 'US' : 'MX';
  }
  if (codes.has('SY') && codes.has('LB')) {
    if (lon >= 36.35 || (lat <= 33.75 && lon >= 36.05)) return 'SY';
    return 'LB';
  }
  if (codes.has('RU') && codes.has('UA')) {
    if ((lat >= 50.25 && lon >= 35.6) || (lon >= 38.7 && lat < 47.8)) return 'RU';
    return 'UA';
  }
  if (codes.has('IN') && codes.has('PK')) {
    if (lon >= 75.20 || (lon >= 74.75 && lat <= 32.10)) return 'IN';
    return 'PK';
  }
  if (codes.has('CN') && codes.has('RU')) {
    if (lon >= 132.0 && lat >= 42.40) return 'RU';
    if (lon >= 131.65 && lat <= 44.10) return 'RU';
    if (lon >= 126.80 && lon <= 128.20 && lat >= 50.27) return 'RU';
    return 'CN';
  }
  if (codes.has('RU') && codes.has('JP')) {
    return lat >= 45.25 && lon >= 142.00 ? 'RU' : 'JP';
  }
  if (codes.has('KP') && codes.has('KR')) {
    const westernDmzLat = 37.75;
    const easternDmzLat = 38.35;
    const progress = Math.min(1, Math.max(0, (lon - 126.0) / 2.5));
    const borderLat = westernDmzLat + progress * (easternDmzLat - westernDmzLat);
    return lat >= borderLat ? 'KP' : 'KR';
  }
  if (codes.has('JP') && codes.has('KR')) {
    if (lat <= 34.85 && lon >= 129.20) return 'JP';
    return 'KR';
  }
  if (codes.has('SA') && codes.has('YE')) {
    return lat >= 17.35 ? 'SA' : 'YE';
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
  const countries = new Set<string>(ZONE_COUNTRY_MAP[zone] || []);
  const coordinateCountry = getClimateAnomalyCoordinateCountry(anomaly);
  if (coordinateCountry) countries.add(coordinateCountry);
  return [...countries].filter((code) => code in TIER1_COUNTRIES);
}

// Exported so scripts/seed-military-cii.mjs's re-embedded copy can be cross-checked
// for parity in tests/seed-military-cii-table-drift.test.mts. The seed cannot import
// from server/ under Railway nixpacks packaging.
export function geoToCountry(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const candidates = BBOX_BY_AREA.filter((b) => isInsideBBox(b, lat, lon));
  if (candidates.length === 0) return null;
  if (isKnownNonTier1BBoxGap(lat, lon, candidates)) return null;
  // Preserve the previous smallest-area bbox tie-break for overlap pairs that
  // do not yet have an explicit border heuristic.
  return resolveKnownBBoxOverlap(lat, lon, candidates) ?? candidates[0]!.code;
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
    return { dynamicScore: 0, trend: 'TREND_DIRECTION_STABLE' as TrendDirection };
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

// --- UCDP conflict classification (ported from the frontend, src/services/conflict/index.ts
// deriveUcdpClassifications + getUcdpFloor) ---
//
// The cached `conflict:ucdp-events:v1` payload (written by scripts/seed-ucdp-events.mjs and
// scripts/ais-relay.cjs) emits per-event rows shaped as
// `{ country, location, violenceType, deathsBest, dateStart, ... }`. There is NO
// `intensity_level` or `type_of_violence` field — the pre-existing scorer read those two
// non-existent keys, so `parseInt(...) === 0` for every event and the UCDP floor/coverage
// were silently dead. The correct classification is the same per-country aggregate the
// frontend uses: a 2-year trailing window scored by total deaths and event count.
// The Redis writers currently keep only a 1-year trailing slice, so the effective
// cached-event window is seed-bounded until retention changes upstream.
const UCDP_CLASSIFICATION_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;

type UcdpIntensity = 'minor' | 'war';

function isRecentUcdpClassificationDate(dateStart: unknown, nowMs: number): boolean {
  const eventMs = finiteNumber(dateStart);
  return eventMs !== null
    && Number.isFinite(nowMs)
    && eventMs <= nowMs
    && nowMs - eventMs < UCDP_CLASSIFICATION_WINDOW_MS;
}

/**
 * Classify each Tier-1 country's live UCDP conflict intensity from the cached event list,
 * matching the frontend `deriveUcdpClassifications` heuristic. Returns only countries that
 * clear the `minor`/`war` threshold (i.e. those that should receive a UCDP floor).
 */
function deriveUcdpIntensityByRegion(
  ucdpEvents: any[] | undefined | null,
  nowMs: number,
): Map<string, UcdpIntensity> {
  // Group by raw country string (frontend groups by `e.country`), then attribute to ISO2.
  const eventsByCountryName = new Map<string, any[]>();
  for (const ev of ucdpEvents ?? []) {
    const name = String(ev?.country || ev?.location || '');
    if (!name) continue;
    if (!eventsByCountryName.has(name)) eventsByCountryName.set(name, []);
    eventsByCountryName.get(name)!.push(ev);
  }

  const byRegion = new Map<string, UcdpIntensity>();
  for (const [countryName, events] of eventsByCountryName) {
    const code = normalizeCountryName(countryName);
    if (!code || !isTier1CountryCode(code)) continue;
    const recent = events.filter((e) => isRecentUcdpClassificationDate(e?.dateStart, nowMs));
    const totalDeaths = recent.reduce((sum, e) => sum + safeNonNegativeNum(e?.deathsBest), 0);
    const eventCount = recent.length;
    let intensity: UcdpIntensity | null = null;
    if (totalDeaths > 1000 || eventCount > 100) intensity = 'war';
    else if (eventCount > 10) intensity = 'minor';
    if (!intensity) continue;
    // Same ISO2 may be reached via multiple raw spellings — keep the stronger classification.
    const prev = byRegion.get(code);
    if (intensity === 'war' || !prev) byRegion.set(code, intensity);
  }
  return byRegion;
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
  ucdpWar: boolean;
  ucdpMinor: boolean;
  outageTotalCount: number;
  outageMajorCount: number;
  outagePartialCount: number;
  climateSeverity: number;
  cyberCriticalCount: number;
  cyberHighCount: number;
  cyberMediumCount: number;
  fireCount: number;
  fireHighCount: number;
  gpsHighCount: number;
  gpsMediumCount: number;
  iranStrikes: number;
  highSeverityStrikes: number;
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
  // Phase 1 (CII unification, plans/unify-cii-single-source.md) — gathered, not yet scored.
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
  // Phase 2 (CII unification) — military activity, gathered, not yet scored.
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
    ucdpWar: false, ucdpMinor: false,
    outageTotalCount: 0, outageMajorCount: 0, outagePartialCount: 0,
    climateSeverity: 0,
    cyberCriticalCount: 0, cyberHighCount: 0, cyberMediumCount: 0,
    fireCount: 0, fireHighCount: 0,
    gpsHighCount: 0, gpsMediumCount: 0,
    iranStrikes: 0, highSeverityStrikes: 0,
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

  return [...recent.map(toRow), ...older.map(toRow)];
}

interface AuxiliarySources {
  ucdpEvents: any[];
  outages: any[];
  climate: any[];
  cyber: any[];
  fires: any[];
  gpsHexes: any[];
  iranEvents: any[];
  orefData: { activeAlertCount: number; historyCount24h: number } | null;
  advisories: { byCountry: Record<string, 'do-not-travel' | 'reconsider' | 'caution'> } | null;
  // Per-country displaced population by ISO3 code (UNHCR — persists after ceasefires)
  displacedByIso3: Record<string, number>;
  newsTopStories: Array<{ countryCode: string | null; threatLevel: string; primaryTitle: string }>;
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

export const CII_REALTIME_REQUIRED_SIGNAL_FAMILY_COUNT = 3;

function emptyAuxiliarySources(): AuxiliarySources {
  return {
    ucdpEvents: [],
    outages: [],
    climate: [],
    cyber: [],
    fires: [],
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
  };
}

async function fetchAuxiliarySources(): Promise<AuxiliarySources> {
  const currentYear = new Date().getFullYear();
  const [ucdpRaw, outagesRaw, climateRaw, cyberRaw, firesRaw, gpsRaw, iranRaw, orefRaw, advisoriesRaw, displacementRaw, insightsRaw, threatSummaryRaw, aviationRaw, earthquakesRaw, sanctionsRaw, sanctionsCountsRaw, temporalRaw, militaryCiiRaw] = await Promise.all([
    getCachedJson('conflict:ucdp-events:v1', true).catch(() => null),
    getCachedJson('infra:outages:v1', true).catch(() => null),
    getCachedJson(CLIMATE_ANOMALIES_KEY, true).catch(() => null),
    getCachedJson('cyber:threats-bootstrap:v2', true).catch(() => null),
    getCachedJson('wildfire:fires:v1', true).catch(() => null),
    getCachedJson('intelligence:gpsjam:v2', true).catch(() => null),
    getCachedJson('conflict:iran-events:v1', true).catch(() => null),
    getCachedJson('relay:oref:history:v1', true).catch(() => null),
    getCachedJson('intelligence:advisories:v1', true).catch(() => null),
    // Try current year, fall back to previous year if not yet seeded
    getCachedJson(`displacement:summary:v1:${currentYear}`, true)
      .catch(() => null)
      .then(d => d ?? getCachedJson(`displacement:summary:v1:${currentYear - 1}`, true).catch(() => null)),
    getCachedJson('news:insights:v1', true).catch(() => null),
    getCachedJson('news:threat:summary:v1', true).catch(() => null),
    // Pre-merged bootstrap (seed-aviation.mjs writes it after merging FAA + intl +
    // NOTAM-synthesized closures). Reading the intl-only key here silently dropped US
    // FAA delays and NOTAM closures from aviationScore.
    getCachedJson('aviation:delays-bootstrap:v2', true).catch(() => null),
    getCachedJson('seismology:earthquakes:v1', true).catch(() => null),
    getCachedJson('sanctions:pressure:v1', true).catch(() => null),
    getCachedJson('sanctions:country-counts:v1', true).catch(() => null),
    getCachedJson('temporal:anomalies:v1', true).catch(() => null),
    getCachedJson('intelligence:military-cii:v1', true).catch(() => null),
  ]);
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

  return {
    ucdpEvents: arr(ucdpRaw, 'events'),
    outages: arr(outagesRaw, 'outages'),
    climate: arr(climateRaw, 'anomalies'),
    cyber: arr(cyberRaw, 'threats'),
    fires: arr(firesRaw, 'fireDetections').length ? arr(firesRaw, 'fireDetections') : arr(firesRaw, 'fires'),
    gpsHexes: arr(gpsRaw, 'hexes'),
    iranEvents: arr(iranRaw, 'events'),
    orefData,
    advisories: advisoriesRaw && typeof advisoriesRaw === 'object' && (advisoriesRaw as any).byCountry
      ? { byCountry: (advisoriesRaw as any).byCountry }
      : null,
    displacedByIso3,
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
  };
}

export function computeCIIScores(
  acled: Array<{ country: string; event_type: string; fatalities: number; daysAgo?: number }>,
  aux: AuxiliarySources,
  trendOptions: CiiTrendComparisonOptions = {},
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

  // --- UCDP ---
  // Per-country aggregate classification (deaths + event count over a 2-year trailing
  // window), matching the frontend `deriveUcdpClassifications`. The cached feed has no
  // `intensity_level`/`type_of_violence` field — see deriveUcdpIntensityByRegion above.
  for (const [code, intensity] of deriveUcdpIntensityByRegion(aux.ucdpEvents, computedAt)) {
    if (!data[code]) continue;
    if (intensity === 'war') data[code].ucdpWar = true;
    else data[code].ucdpMinor = true;
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

  // --- Cyber ---
  for (const t of aux.cyber) {
    const code = (t.country || '').toUpperCase();
    if (!data[code]) continue;
    // Split by the severity the cached cyber threat already carries (Phase 3b / D7).
    // seed-cyber-threats.mjs emits the proto enum form ('CRITICALITY_LEVEL_CRITICAL' etc.)
    // — strip the prefix so bare lowercase fixtures and the production enum both bucket.
    // NOTE: 'low' / 'info' / unknown severities are intentionally dropped. Pre-unification
    // the server used a flat `cyberCount++` for every threat regardless of severity, but
    // the only consumer (cyberBoost in the blend below) reads critical/high/medium with
    // weights 3 / 1.8 / 0.9 — matching the frontend formula at
    // src/services/country-instability.ts:609. A 'low' would have no coefficient to land
    // on, so counting it would be a no-op anyway; the drop just makes the contract explicit.
    const sev = String(t.severity || '').toLowerCase().replace(/^criticality_level_/, '');
    if (sev === 'critical') data[code].cyberCriticalCount++;
    else if (sev === 'high') data[code].cyberHighCount++;
    else if (sev === 'medium') data[code].cyberMediumCount++;
  }

  // --- Fires ---
  for (const f of aux.fires) {
    const lat = safeNum(f.lat || f.latitude || f.location?.latitude);
    const lon = safeNum(f.lon || f.longitude || f.location?.longitude);
    const code = geoToCountry(lat, lon);
    if (!code || !data[code]) continue;
    data[code].fireCount++;
    // "High" fire — bright or high radiative power (Phase 3b / D8, matches the frontend).
    if (safeNonNegativeNum(f.brightness) >= 360 || safeNonNegativeNum(f.frp) >= 50) data[code].fireHighCount++;
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
    const code = geoToCountry(safeNum(eq.location?.latitude), safeNum(eq.location?.longitude));
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

  // --- Iran strikes with severity ---
  for (const s of aux.iranEvents) {
    const lat = safeNum(s.lat || s.latitude);
    const lon = safeNum(s.lon || s.longitude);
    const code = geoToCountry(lat, lon) || normalizeCountryName(s.title || s.location || '');
    if (!code || !data[code]) continue;
    data[code].iranStrikes++;
    const sev = String(s.severity || '').toLowerCase();
    if (sev === 'high' || sev === 'critical') data[code].highSeverityStrikes++;
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
    // Primary attribution via countryCode from seed-insights geo-extraction
    let code: string | null = story.countryCode && data[story.countryCode] ? story.countryCode : null;
    // Fallback: keyword match on title
    if (!code) code = normalizeCountryName(story.primaryTitle);
    const signals = code ? data[code] : undefined;
    if (signals) signals.newsScore += weight;
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
    const unrest = Math.min(100, Math.round(unrestBase + unrestFatalityBoost + unrestSeverityBoost + outageBoost));

    // --- Conflict score (ported from frontend calcConflictScore) ---
    const conflictActivityRaw = (d.battles * 3 + d.explosions * 4 + d.civilianViolence * 5) * multiplier;
    const acledScore = Math.round(logScaledScore(
      conflictActivityRaw,
      CII_CONFLICT_ACTIVITY_CAP,
      CII_CONFLICT_ACTIVITY_PIVOT,
    ));
    const fatalityScore = Math.min(40, Math.round(Math.sqrt(d.conflictFatalities) * 5 * multiplier));
    const civilianBoost = Math.min(10, d.civilianViolence * 3);
    const strikeBoost = Math.min(50, d.iranStrikes * 3 + d.highSeverityStrikes * 5);
    const orefBoost = (code === 'IL' && d.orefAlertCount > 0)
      ? 25 + Math.min(25, d.orefAlertCount * 5)
      : 0;
    const conflict = Math.min(100, acledScore + fatalityScore + civilianBoost + strikeBoost + orefBoost);

    // --- Security score (Phase 3b / decision C3 — full 4-input calcSecurityScore) ---
    // Was GPS-only (issue #3738). Now flights + vessels + aviation + GPS, matching the
    // frontend. Military counts reconstruct the frontend's array length: foreign presence
    // is weighted ×2 (the intent of ingestMilitaryForCII's synthetic-{} push), applied
    // here in the formula instead of as a representation hack.
    const milFlights = d.militaryOwnFlights + d.militaryForeignFlights * 2;
    const milVessels = d.militaryOwnVessels + d.militaryForeignVessels * 2;
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
    // cyber + fire (Phase 3b / D7, D8) — severity-weighted, ported from the frontend
    // getSupplementalSignalBoost. Was total-count based; the cached cyber/fire feeds
    // already carry severity / brightness, so this is a faithful port, not a partial one.
    const cyberBoost = Math.min(12, d.cyberCriticalCount * 3 + d.cyberHighCount * 1.8 + d.cyberMediumCount * 0.9);
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
    // supplementalSignalBoost (D4): the frontend's helper sums AIS + fire + cyber +
    // temporal. AIS is its own blend term below; cyber + fire are the severity-weighted
    // terms above. The temporal sub-boost is NOT wired — the temporal:anomalies:v1
    // producer (list-temporal-anomalies.ts) emits every anomaly with region:'global', so
    // they cannot be country-attributed. `temporalAnomaly*Count` stay gathered-not-scored
    // (Phase 1 intent); re-wire a temporalBoost only if the producer emits country-scoped
    // anomalies. The frontend's temporal sub-boost has the same dormancy for the same reason.
    const aisBoost = Math.min(
      10,
      d.aisDisruptionHighCount * 2.5 + d.aisDisruptionElevatedCount * 1.5 + d.aisDisruptionLowCount * 0.5,
    );

    const blended = baseline * 0.4
      + eventScore * 0.6
      + climateBoost
      + cyberBoost
      + fireBoost
      + advisoryBoost
      + orefBlendBoost
      + displacementBoost
      + newsUrgencyBoost
      + earthquakeBoost
      + sanctionsBoost
      + aisBoost;

    // --- Floors ---
    const ucdpFloor = d.ucdpWar ? 70 : (d.ucdpMinor ? 50 : 0);
    const advisoryFloor = d.advisoryLevel === 'do-not-travel' ? 60
      : d.advisoryLevel === 'reconsider' ? 50 : 0;
    const floor = Math.max(ucdpFloor, advisoryFloor);

    const composite = Math.min(100, Math.max(floor, Math.round(blended)));
    const { dynamicScore, trend } = deriveCiiTrendDelta(composite, priorByRegion.get(code), computedAt);

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
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
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
  const coveredFamilies = new Set<'conflict' | 'news' | 'cyber'>();

  // Conflict family: satisfied by EITHER the ACLED API path OR the UCDP aux feed.
  // ACLED is only one of two live conflict sources both consumed by computeCIIScores —
  // when the ACLED API path returns empty (rate-limit/auth/quiet window), the rich
  // `conflict:ucdp-events:v1` feed (15+ Tier-1 countries) still drives the score floor,
  // so the conflict signal is genuinely alive and must count toward health coverage.
  // Requiring ACLED specifically here flipped /api/health.riskScores to COVERAGE_PARTIAL
  // whenever ACLED was thin even though UCDP was fully healthy.
  const acledCoversTier1 = (acled ?? []).some((ev) => isTier1CountryCode(normalizeCountryName(ev.country)));
  const ucdpCoversTier1 = deriveUcdpIntensityByRegion(aux?.ucdpEvents, nowMs).size > 0;
  if (acledCoversTier1 || ucdpCoversTier1) {
    coveredFamilies.add('conflict');
  }

  for (const story of aux?.newsTopStories ?? []) {
    const weight = NEWS_THREAT_WEIGHT[String(story.threatLevel || '').toLowerCase()] ?? 0;
    if (weight <= 0) continue;
    if (
      isTier1CountryCode(story.countryCode)
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

  for (const threat of aux?.cyber ?? []) {
    const code = String(threat.country || '').trim().toUpperCase();
    const severity = String(threat.severity || '').toLowerCase().replace(/^criticality_level_/, '');
    if (
      isTier1CountryCode(code)
      && (severity === 'critical' || severity === 'high' || severity === 'medium')
    ) {
      coveredFamilies.add('cyber');
      break;
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
const RISK_CACHE_KEY = `risk:scores:sebuf:${CII_FORMULA_VERSION}`;
const RISK_STALE_CACHE_KEY = `risk:scores:sebuf:stale:${CII_FORMULA_VERSION}`;
const RISK_TREND_HISTORY_CACHE_KEY_PREFIX = `risk:scores:sebuf:trend-history:${CII_FORMULA_VERSION}`;
// `region` is deliberately excluded from the Redis key: this endpoint caches
// the all-country payload once and applies any region filter as a read-only
// projection at return time, so per-region requests cannot poison global cache.
const RISK_CACHE_TTL = 600;
const RISK_STALE_TTL = 3600;
const CII_TREND_HISTORY_TTL = 3 * 24 * 60 * 60;

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

async function readCiiTrendPriorScores(nowMs: number): Promise<CiiScore[] | null> {
  const snapshots = await Promise.all(
    getCiiTrendPriorCandidateBuckets(nowMs).map(async (bucket) => {
      const value = await getCachedJson(ciiTrendHistoryCacheKey(bucket)).catch(() => null);
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

async function buildRiskScoresPayload(): Promise<{
  response: GetRiskScoresResponse;
  realtimeSignalDensityCoverageCount: number;
}> {
  const nowMs = Date.now();
  const [acled, aux, priorCiiScores] = await Promise.all([
    fetchACLEDEvents(),
    fetchAuxiliarySources(),
    readCiiTrendPriorScores(nowMs),
  ]);
  if (!priorCiiScores?.length) recordCiiTrendPriorGap(nowMs);
  const realtimeSignalDensityCoverageCount = countCiiRealtimeSignalDensityCoverage(acled, aux, nowMs);
  const ciiScores = computeCIIScores(acled, aux, { priorScores: priorCiiScores, nowMs });
  const strategicRisks = computeStrategicRisks(ciiScores);
  return {
    response: { ciiScores, strategicRisks, degraded: false, stale: false },
    realtimeSignalDensityCoverageCount,
  };
}

async function persistFreshRiskScorePayload(
  freshResult: GetRiskScoresResponse,
  realtimeSignalDensityCoverageCount: number,
  options: { liveCache?: boolean } = {},
): Promise<void> {
  const writes: Array<Promise<unknown>> = [
    setCachedJson(RISK_STALE_CACHE_KEY, freshResult, RISK_STALE_TTL),
    persistCiiTrendSnapshot(freshResult),
    setCachedJson(
      'seed-meta:intelligence:risk-scores',
      { fetchedAt: Date.now(), recordCount: realtimeSignalDensityCoverageCount },
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
    const { data: result, source, leader } = await cachedFetchJsonWithMeta<GetRiskScoresResponse>(
      RISK_CACHE_KEY,
      RISK_CACHE_TTL,
      async () => {
        const built = await buildRiskScoresPayload();
        realtimeSignalDensityCoverageCount = built.realtimeSignalDensityCoverageCount;
        return built.response;
      },
    );
    if (result) {
      let freshResult = withRiskScoreRuntimeState(result, { degraded: false, stale: false });
      let liveCacheBackfill = false;
      if (!hasCompleteRiskScoreAdvisoryDisclosure(freshResult)) {
        try {
          const built = await buildRiskScoresPayload();
          realtimeSignalDensityCoverageCount = built.realtimeSignalDensityCoverageCount;
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
        await persistFreshRiskScorePayload(freshResult, realtimeSignalDensityCoverageCount, {
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
