import type {
  ServerContext,
  GetRiskScoresRequest,
  GetRiskScoresResponse,
  CiiScore,
  StrategicRisk,
  TrendDirection,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson, cachedFetchJson } from '../../../_shared/redis';
import { TIER1_COUNTRIES } from './_shared';
import { fetchAcledCached } from '../../../_shared/acled';

// ========================================================================
// Country risk baselines and multipliers
// ========================================================================

const BASELINE_RISK: Record<string, number> = {
  US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45,
  SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35,
  SY: 50, YE: 50, MM: 45, VE: 40, CU: 45,
};

const EVENT_MULTIPLIER: Record<string, number> = {
  US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0,
  SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5,
  SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8, CU: 2.0,
};

const COUNTRY_KEYWORDS: Record<string, string[]> = {
  US: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'riyadh'],
  TR: ['turkey', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris', 'macron'],
  GB: ['britain', 'uk', 'london'],
  IN: ['india', 'delhi', 'modi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus'],
  YE: ['yemen', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma'],
  VE: ['venezuela', 'caracas', 'maduro'],
  CU: ['cuba', 'havana', 'diaz-canel'],
};

const COUNTRY_BBOX: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number }> = {
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
};

const ZONE_COUNTRY_MAP: Record<string, string[]> = {
  'North America': ['US'], 'Europe': ['DE', 'FR', 'GB', 'PL', 'TR', 'UA'],
  'East Asia': ['CN', 'TW', 'KP'], 'South Asia': ['IN', 'PK', 'MM'],
  'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE'], 'Russia': ['RU'],
  'Latin America': ['VE', 'CU'],
};

// ========================================================================
// Internal helpers
// ========================================================================

function normalizeCountryName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return code;
  }
  return null;
}

function geoToCountry(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const [code, bbox] of Object.entries(COUNTRY_BBOX)) {
    if (lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon) return code;
  }
  return null;
}

interface CountrySignals {
  protests: number;
  riots: number;
  battles: number;
  explosions: number;
  civilianViolence: number;
  fatalities: number;
  ucdpWar: boolean;
  ucdpMinor: boolean;
  outageBoost: number;
  climateSeverity: number;
  cyberCount: number;
  fireCount: number;
  gpsHexCount: number;
  iranStrikes: number;
}

function emptySignals(): CountrySignals {
  return { protests: 0, riots: 0, battles: 0, explosions: 0, civilianViolence: 0, fatalities: 0, ucdpWar: false, ucdpMinor: false, outageBoost: 0, climateSeverity: 0, cyberCount: 0, fireCount: 0, gpsHexCount: 0, iranStrikes: 0 };
}

async function fetchACLEDEvents(): Promise<Array<{ country: string; event_type: string; fatalities: number }>> {
  const endDate = new Date().toISOString().split('T')[0]!;
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
  const raw = await fetchAcledCached({
    eventTypes: 'Protests|Riots|Battles|Explosions/Remote violence|Violence against civilians',
    startDate,
    endDate,
    limit: 1000,
  });
  return raw.map((e) => ({
    country: e.country || '',
    event_type: e.event_type || '',
    fatalities: parseInt(e.fatalities || '0', 10) || 0,
  }));
}

async function fetchAuxiliarySources(): Promise<{
  ucdpEvents: any[];
  outages: any[];
  climate: any[];
  cyber: any[];
  fires: any[];
  gpsHexes: any[];
  iranEvents: any[];
}> {
  const [ucdpRaw, outagesRaw, climateRaw, cyberRaw, firesRaw, gpsRaw, iranRaw] = await Promise.all([
    getCachedJson('conflict:ucdp-events:v1', true).catch(() => null),
    getCachedJson('infra:outages:v1', true).catch(() => null),
    getCachedJson('climate:anomalies:v1', true).catch(() => null),
    getCachedJson('cyber:threats-bootstrap:v2', true).catch(() => null),
    getCachedJson('wildfire:fires:v1', true).catch(() => null),
    getCachedJson('intelligence:gpsjam:v2', true).catch(() => null),
    getCachedJson('conflict:iran-events:v1', true).catch(() => null),
  ]);
  const arr = (v: any, field?: string) => {
    if (field && v && Array.isArray(v[field])) return v[field];
    return Array.isArray(v) ? v : [];
  };
  return {
    ucdpEvents: arr(ucdpRaw, 'events'),
    outages: arr(outagesRaw, 'outages'),
    climate: arr(climateRaw, 'anomalies'),
    cyber: arr(cyberRaw, 'threats'),
    fires: arr(firesRaw, 'fireDetections') || arr(firesRaw, 'fires'),
    gpsHexes: arr(gpsRaw, 'hexes'),
    iranEvents: arr(iranRaw, 'events'),
  };
}

function computeCIIScores(
  acled: Array<{ country: string; event_type: string; fatalities: number }>,
  aux: Awaited<ReturnType<typeof fetchAuxiliarySources>>,
): CiiScore[] {
  const data: Record<string, CountrySignals> = {};
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    data[code] = emptySignals();
  }

  for (const ev of acled) {
    const code = normalizeCountryName(ev.country);
    if (!code || !data[code]) continue;
    const type = ev.event_type.toLowerCase();
    if (type.includes('protest')) data[code].protests++;
    else if (type.includes('riot')) data[code].riots++;
    else if (type.includes('battle')) data[code].battles++;
    else if (type.includes('explosion') || type.includes('remote')) data[code].explosions++;
    else if (type.includes('violence')) data[code].civilianViolence++;
    data[code].fatalities += ev.fatalities;
  }

  for (const ev of aux.ucdpEvents) {
    const code = normalizeCountryName(ev.country || ev.location || '');
    if (!code || !data[code]) continue;
    const intensity = parseInt(ev.intensity_level || ev.type_of_violence || '0', 10);
    if (intensity >= 2) data[code].ucdpWar = true;
    else if (intensity >= 1) data[code].ucdpMinor = true;
  }

  for (const o of aux.outages) {
    const code = (o.countryCode || o.country_code || '').toUpperCase();
    if (data[code]) {
      const severity = Number(o.severity || o.score || 0);
      data[code].outageBoost = Math.max(data[code].outageBoost, Math.min(10, severity * 2));
    }
  }

  for (const a of aux.climate) {
    const zone = a.zone || a.region || '';
    const countries = ZONE_COUNTRY_MAP[zone] || [];
    const severity = Number(a.severity || a.score || 0);
    for (const code of countries) {
      if (data[code]) data[code].climateSeverity = Math.max(data[code].climateSeverity, severity);
    }
  }

  for (const t of aux.cyber) {
    const code = (t.country || '').toUpperCase();
    if (data[code]) data[code].cyberCount++;
  }

  for (const f of aux.fires) {
    const lat = Number(f.lat || f.latitude || f.location?.latitude);
    const lon = Number(f.lon || f.longitude || f.location?.longitude);
    const code = geoToCountry(lat, lon);
    if (code && data[code]) data[code].fireCount++;
  }

  for (const h of aux.gpsHexes) {
    const lat = Number(h.lat || h.latitude);
    const lon = Number(h.lon || h.longitude);
    const code = geoToCountry(lat, lon);
    if (code && data[code]) data[code].gpsHexCount++;
  }

  for (const s of aux.iranEvents) {
    const lat = Number(s.lat || s.latitude);
    const lon = Number(s.lon || s.longitude);
    const code = geoToCountry(lat, lon) || normalizeCountryName(s.title || s.location || '');
    if (code && data[code]) data[code].iranStrikes++;
  }

  const scores: CiiScore[] = [];
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    const d = data[code]!;
    const baseline = BASELINE_RISK[code] || 20;
    const multiplier = EVENT_MULTIPLIER[code] || 1.0;

    const unrest = Math.min(100, Math.round((d.protests * multiplier + d.riots * multiplier * 2 + d.outageBoost) * 2));
    const conflict = Math.min(100, Math.round((d.battles + d.explosions + d.civilianViolence + d.fatalities * 0.5 + d.iranStrikes * 3) * multiplier));
    const security = Math.min(100, Math.round(d.gpsHexCount * 3 * multiplier));
    const information = 0;

    const eventScore = unrest * 0.25 + conflict * 0.30 + security * 0.20 + information * 0.25;

    const climateBoost = Math.min(15, d.climateSeverity * 3);
    const cyberBoost = Math.min(10, Math.floor(d.cyberCount / 5));
    const fireBoost = Math.min(8, Math.floor(d.fireCount / 10));

    const blended = baseline * 0.4 + eventScore * 0.6 + climateBoost + cyberBoost + fireBoost;

    const floor = d.ucdpWar ? 70 : (d.ucdpMinor ? 50 : 0);
    const composite = Math.min(100, Math.max(floor, Math.round(blended)));

    scores.push({
      region: code,
      staticBaseline: baseline,
      dynamicScore: composite - baseline,
      combinedScore: composite,
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
      components: {
        newsActivity: information,
        ciiContribution: unrest,
        geoConvergence: conflict,
        militaryActivity: security,
      },
      computedAt: Date.now(),
    });
  }

  scores.sort((a, b) => b.combinedScore - a.combinedScore);
  return scores;
}

function computeStrategicRisks(ciiScores: CiiScore[]): StrategicRisk[] {
  const top5 = ciiScores.slice(0, 5);
  const weights = top5.map((_, i) => 1 - i * 0.15);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const weightedSum = top5.reduce((sum, s, i) => sum + s.combinedScore * weights[i]!, 0);
  const overallScore = Math.min(100, Math.round((weightedSum / totalWeight) * 0.7 + 15));

  return [
    {
      region: 'global',
      level: (overallScore >= 70
        ? 'SEVERITY_LEVEL_HIGH'
        : overallScore >= 40
          ? 'SEVERITY_LEVEL_MEDIUM'
          : 'SEVERITY_LEVEL_LOW') as SeverityLevel,
      score: overallScore,
      factors: top5.map((s) => s.region),
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
    },
  ];
}

// ========================================================================
// Cache keys
// ========================================================================

const RISK_CACHE_KEY = 'risk:scores:sebuf:v1';
const RISK_STALE_CACHE_KEY = 'risk:scores:sebuf:stale:v1';
const RISK_CACHE_TTL = 600;
const RISK_STALE_TTL = 3600;

// ========================================================================
// RPC handler
// ========================================================================

export async function getRiskScores(
  _ctx: ServerContext,
  _req: GetRiskScoresRequest,
): Promise<GetRiskScoresResponse> {
  try {
    const result = await cachedFetchJson<GetRiskScoresResponse>(
      RISK_CACHE_KEY,
      RISK_CACHE_TTL,
      async () => {
        const [acled, aux] = await Promise.all([
          fetchACLEDEvents(),
          fetchAuxiliarySources(),
        ]);
        const ciiScores = computeCIIScores(acled, aux);
        const strategicRisks = computeStrategicRisks(ciiScores);
        const r: GetRiskScoresResponse = { ciiScores, strategicRisks };
        await setCachedJson(RISK_STALE_CACHE_KEY, r, RISK_STALE_TTL).catch(() => {});
        return r;
      },
    );
    if (result) return result;
  } catch { /* upstream failed — fall through to stale */ }

  const stale = (await getCachedJson(RISK_STALE_CACHE_KEY)) as GetRiskScoresResponse | null;
  if (stale) return stale;
  const ciiScores = computeCIIScores([], { ucdpEvents: [], outages: [], climate: [], cyber: [], fires: [], gpsHexes: [], iranEvents: [] });
  return { ciiScores, strategicRisks: computeStrategicRisks(ciiScores) };
}
