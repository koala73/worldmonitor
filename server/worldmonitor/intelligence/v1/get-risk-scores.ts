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

// ========================================================================
// Country risk baselines and multipliers
// ========================================================================

const BASELINE_RISK: Record<string, number> = {
  US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45,
  SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35,
  SY: 50, YE: 50, MM: 45, VE: 40, CU: 45, MX: 35, BR: 15, AE: 10,
  KR: 15, IQ: 40, AF: 45, LB: 40, EG: 20, JP: 5, QA: 10,
};

const EVENT_MULTIPLIER: Record<string, number> = {
  US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0,
  SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5,
  SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8, CU: 2.0, MX: 1.0, BR: 0.6, AE: 1.5,
  KR: 0.8, IQ: 1.2, AF: 0.8, LB: 1.5, EG: 1.0, JP: 0.5, QA: 0.8,
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
  MX: ['mexico', 'mexican', 'sheinbaum', 'cartel', 'sinaloa'],
  BR: ['brazil', 'brasilia', 'lula'],
  AE: ['uae', 'emirates', 'dubai', 'abu dhabi', 'united arab emirates'],
  KR: ['south korea', 'korean peninsula', 'seoul', 'yoon'],
  IQ: ['iraq', 'iraqi', 'baghdad', 'kurdistan', 'mosul', 'basra'],
  AF: ['afghanistan', 'afghan', 'kabul', 'taliban', 'kandahar'],
  LB: ['lebanon', 'lebanese', 'beirut', 'hezbollah', 'nasrallah'],
  EG: ['egypt', 'egyptian', 'cairo', 'suez', 'sisi'],
  JP: ['japan', 'japanese', 'tokyo', 'okinawa', 'kishida'],
  QA: ['qatar', 'qatari', 'doha', 'al jazeera'],
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

const ZONE_COUNTRY_MAP: Record<string, string[]> = {
  'North America': ['US'], 'Europe': ['DE', 'FR', 'GB', 'PL', 'TR', 'UA'],
  'East Asia': ['CN', 'TW', 'KP', 'KR', 'JP'], 'South Asia': ['IN', 'PK', 'MM', 'AF'],
  'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE', 'AE', 'IQ', 'LB', 'QA'], 'Russia': ['RU'],
  'Latin America': ['VE', 'CU', 'MX', 'BR'], 'North Africa': ['EG'],
};

const ADVISORY_LEVELS_FALLBACK: Record<string, 'do-not-travel' | 'reconsider' | 'caution'> = {
  UA: 'do-not-travel', SY: 'do-not-travel', YE: 'do-not-travel', MM: 'do-not-travel',
  IL: 'reconsider', IR: 'reconsider', PK: 'reconsider', VE: 'reconsider', CU: 'reconsider', MX: 'reconsider',
  RU: 'caution', TR: 'caution', IQ: 'reconsider', AF: 'do-not-travel', LB: 'reconsider',
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

const BBOX_BY_AREA = Object.entries(COUNTRY_BBOX)
  .map(([code, b]) => ({ code, ...b, area: (b.maxLat - b.minLat) * (b.maxLon - b.minLon) }))
  .sort((a, b) => a.area - b.area);

function geoToCountry(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const b of BBOX_BY_AREA) {
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) return b.code;
  }
  return null;
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const ISO3_TO_ISO2: Record<string, string> = iso3ToIso2Json;

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
  cyberCount: number;
  fireCount: number;
  gpsHighCount: number;
  gpsMediumCount: number;
  iranStrikes: number;
  highSeverityStrikes: number;
  orefAlertCount: number;
  orefHistoryCount24h: number;
  advisoryLevel: 'do-not-travel' | 'reconsider' | 'caution' | null;
  totalDisplaced: number;
  newsScore: number;
  threatSummaryScore: number;
}

function emptySignals(): CountrySignals {
  return {
    protests: 0, riots: 0, battles: 0, explosions: 0, civilianViolence: 0,
    fatalities: 0, protestFatalities: 0, conflictFatalities: 0,
    ucdpWar: false, ucdpMinor: false,
    outageTotalCount: 0, outageMajorCount: 0, outagePartialCount: 0,
    climateSeverity: 0, cyberCount: 0, fireCount: 0,
    gpsHighCount: 0, gpsMediumCount: 0,
    iranStrikes: 0, highSeverityStrikes: 0,
    orefAlertCount: 0, orefHistoryCount24h: 0,
    advisoryLevel: null,
    totalDisplaced: 0,
    newsScore: 0,
    threatSummaryScore: 0,
  };
}

async function fetchACLEDEvents(): Promise<Array<{ country: string; event_type: string; fatalities: number; daysAgo: number }>> {
  const now = Date.now();
  const today = new Date(now).toISOString().split('T')[0]!;
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
  const eventTypes = 'Protests|Riots|Battles|Explosions/Remote violence|Violence against civilians';

  // Two separate cached queries so each window has its own 1 000-event budget.
  // A single 30-day request at limit:1500 silently drops tail events once the
  // global count exceeds the cap; splitting ensures post-conflict countries
  // (low recent activity, higher older activity) are not squeezed out.
  const [recent, older] = await Promise.all([
    fetchAcledCached({ eventTypes, startDate: sevenDaysAgo, endDate: today, limit: 1000 }),
    fetchAcledCached({ eventTypes, startDate: thirtyDaysAgo, endDate: sevenDaysAgo, limit: 1000 }),
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
}

async function fetchAuxiliarySources(): Promise<AuxiliarySources> {
  const currentYear = new Date().getFullYear();
  const [ucdpRaw, outagesRaw, climateRaw, cyberRaw, firesRaw, gpsRaw, iranRaw, orefRaw, advisoriesRaw, displacementRaw, insightsRaw, threatSummaryRaw] = await Promise.all([
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
  ]);
  const arr = (v: any, field?: string, maxLen = 10000) => {
    let a: any[];
    if (field && v && Array.isArray(v[field])) a = v[field];
    else a = Array.isArray(v) ? v : [];
    return a.length > maxLen ? a.slice(0, maxLen) : a;
  };

  let orefData: AuxiliarySources['orefData'] = null;
  if (orefRaw && typeof orefRaw === 'object') {
    const alertCount = safeNum((orefRaw as any).activeAlertCount);
    const histCount = safeNum((orefRaw as any).historyCount24h);
    orefData = { activeAlertCount: alertCount, historyCount24h: histCount };
  }

  // Build ISO3→totalDisplaced map from UNHCR displacement summary
  const displacedByIso3: Record<string, number> = {};
  const dispCountries: any[] = arr(displacementRaw, 'countries');
  for (const c of dispCountries) {
    const iso3 = String(c.code || '').toUpperCase();
    if (iso3) displacedByIso3[iso3] = safeNum(c.totalDisplaced);
  }
  // Also try nested summary.countries (seed wraps in { summary: { countries: [...] } })
  if (dispCountries.length === 0) {
    const summaryCountries: any[] = arr((displacementRaw as any)?.summary, 'countries');
    for (const c of summaryCountries) {
      const iso3 = String(c.code || '').toUpperCase();
      if (iso3) displacedByIso3[iso3] = safeNum(c.totalDisplaced);
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
  };
}

export function computeCIIScores(
  acled: Array<{ country: string; event_type: string; fatalities: number; daysAgo?: number }>,
  aux: AuxiliarySources,
): CiiScore[] {
  const data: Record<string, CountrySignals> = {};
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    data[code] = emptySignals();
    const liveLevel = aux.advisories?.byCountry?.[code] ?? null;
    data[code].advisoryLevel = liveLevel || ADVISORY_LEVELS_FALLBACK[code] || null;
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
    const fat = safeNum(ev.fatalities) * weight;
    if (type.includes('protest')) {
      data[code].protests += weight;
      data[code].protestFatalities += fat;
    } else if (type.includes('riot')) {
      data[code].riots += weight;
      data[code].protestFatalities += fat;
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
  for (const ev of aux.ucdpEvents) {
    const code = normalizeCountryName(ev.country || ev.location || '');
    if (!code || !data[code]) continue;
    const intensity = parseInt(ev.intensity_level || ev.type_of_violence || '0', 10);
    if (intensity >= 2) data[code].ucdpWar = true;
    else if (intensity >= 1) data[code].ucdpMinor = true;
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
    const zone = a.zone || a.region || '';
    const countries = ZONE_COUNTRY_MAP[zone] || [];
    const severity = safeNum(a.severity ?? a.score);
    for (const code of countries) {
      if (data[code]) data[code].climateSeverity = Math.max(data[code].climateSeverity, severity);
    }
  }

  // --- Cyber ---
  for (const t of aux.cyber) {
    const code = (t.country || '').toUpperCase();
    if (data[code]) data[code].cyberCount++;
  }

  // --- Fires ---
  for (const f of aux.fires) {
    const lat = safeNum(f.lat || f.latitude || f.location?.latitude);
    const lon = safeNum(f.lon || f.longitude || f.location?.longitude);
    const code = geoToCountry(lat, lon);
    if (code && data[code]) data[code].fireCount++;
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
  const THREAT_WEIGHT: Record<string, number> = {
    critical: 4, high: 2, medium: 1, elevated: 1, moderate: 0.5, low: 0.5, info: 0,
  };
  for (const story of aux.newsTopStories) {
    const weight = THREAT_WEIGHT[story.threatLevel] ?? 0;
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
        score += (counts[lvl as keyof typeof counts] || 0) * w;
      }
      signals.threatSummaryScore = Math.min(20, score);
    }
  }

  // --- Scoring ---
  const scores: CiiScore[] = [];
  for (const code of Object.keys(TIER1_COUNTRIES)) {
    const d = data[code]!;
    const baseline = BASELINE_RISK[code] || 20;
    const multiplier = EVENT_MULTIPLIER[code] || 1.0;

    // --- Unrest score (ported from frontend calcUnrestScore) ---
    const unrestCount = d.protests + d.riots;
    const adjustedCount = multiplier < 0.7
      ? Math.log2(unrestCount + 1) * multiplier * 5
      : unrestCount * multiplier;
    const unrestBase = Math.min(50, adjustedCount * 8);
    const unrestFatalityBoost = Math.min(30, d.protestFatalities * 5 * multiplier);
    const outageBoost = Math.min(50, d.outageTotalCount * 30 + d.outageMajorCount * 15 + d.outagePartialCount * 5);
    const unrest = Math.min(100, Math.round(unrestBase + unrestFatalityBoost + outageBoost));

    // --- Conflict score (ported from frontend calcConflictScore) ---
    const acledScore = Math.min(50, Math.round((d.battles * 3 + d.explosions * 4 + d.civilianViolence * 5) * multiplier));
    const fatalityScore = Math.min(40, Math.round(Math.sqrt(d.conflictFatalities) * 5 * multiplier));
    const civilianBoost = Math.min(10, d.civilianViolence * 3);
    const strikeBoost = Math.min(50, d.iranStrikes * 3 + d.highSeverityStrikes * 5);
    const orefBoost = (code === 'IL' && d.orefAlertCount > 0)
      ? 25 + Math.min(25, d.orefAlertCount * 5)
      : 0;
    const conflict = Math.min(100, acledScore + fatalityScore + civilianBoost + strikeBoost + orefBoost);

    // --- Security score (ported from frontend calcSecurityScore) ---
    const gpsJammingScore = Math.min(35, d.gpsHighCount * 5 + d.gpsMediumCount * 2);
    const security = Math.min(100, Math.round(gpsJammingScore));

    const information = Math.min(20, d.newsScore + d.threatSummaryScore);

    const eventScore = unrest * 0.25 + conflict * 0.30 + security * 0.20 + information * 0.25;

    const climateBoost = Math.min(15, d.climateSeverity * 3);
    const cyberBoost = Math.min(10, Math.floor(d.cyberCount / 5));
    const fireBoost = Math.min(8, Math.floor(d.fireCount / 10));

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
    //   100K  → +4  |  500K → +9  |  1M → +12  |  5M → +18  |  10M+ → +20
    // Formula: (log10(n) - 5) * 8 + 4, clamped [0, 20].
    // Below ~32K displaced → 0; cap reached at 10M.
    const displacementBoost = d.totalDisplaced > 0
      ? Math.min(20, Math.max(0, Math.round((Math.log10(d.totalDisplaced) - 5) * 8 + 4)))
      : 0;

    const blended = baseline * 0.4
      + eventScore * 0.6
      + climateBoost
      + cyberBoost
      + fireBoost
      + advisoryBoost
      + orefBlendBoost
      + displacementBoost;

    // --- Floors ---
    const ucdpFloor = d.ucdpWar ? 70 : (d.ucdpMinor ? 50 : 0);
    const advisoryFloor = d.advisoryLevel === 'do-not-travel' ? 60
      : d.advisoryLevel === 'reconsider' ? 50 : 0;
    const floor = Math.max(ucdpFloor, advisoryFloor);

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
    const { data: result, source } = await cachedFetchJsonWithMeta<GetRiskScoresResponse>(
      RISK_CACHE_KEY,
      RISK_CACHE_TTL,
      async () => {
        const [acled, aux] = await Promise.all([
          fetchACLEDEvents(),
          fetchAuxiliarySources(),
        ]);
        const ciiScores = computeCIIScores(acled, aux);
        const strategicRisks = computeStrategicRisks(ciiScores);
        return { ciiScores, strategicRisks };
      },
    );
    if (result) {
      await setCachedJson(RISK_STALE_CACHE_KEY, result, RISK_STALE_TTL).catch(() => {});
      // Write seed-meta on every FRESH upstream fetch so /api/health.riskScores
      // stays green from real user traffic, independent of the ais-relay
      // CII warm-ping. Pre-2026-05-02 the warm-ping was the SOLE writer of
      // this seed-meta — when the relay → api.worldmonitor.app auth path
      // broke (all warm-ping types started returning HTTP 401 simultaneously),
      // riskScores was the only key that flipped STALE because cable-health
      // and chokepoints had RPC-side seed-meta writes keeping them fresh
      // via real user traffic. This brings riskScores into the same pattern
      // as those two: defense-in-depth, no single point of freshness failure.
      //
      // Gated on source === 'fresh' (PR #3562 review P2): cachedFetchJsonWithMeta
      // returns immediately on cache hits with `source: 'cache'`. Stamping
      // `fetchedAt: Date.now()` on cache hits would conflate "data was
      // recently re-fetched" with "data was recently served," letting
      // health.riskScores stay fresh even when upstream stopped responding
      // (cache would be served until its TTL=600s expired, after which the
      // first request triggers a fresh fetch and surfaces the failure
      // properly — but only if seed-meta wasn't already advanced by a cache
      // hit). Only stamp on actual upstream re-fetches.
      // 7-day TTL matches the warm-ping write so health.maxStaleMin (30min)
      // logic is unchanged.
      if (source === 'fresh') {
        const count = result.ciiScores?.length || 0;
        if (count > 0) {
          await setCachedJson(
            'seed-meta:intelligence:risk-scores',
            { fetchedAt: Date.now(), recordCount: count },
            604800,
          ).catch(() => {});
        }
      }
      return result;
    }
  } catch { /* upstream failed, fall through to stale */ }

  const stale = (await getCachedJson(RISK_STALE_CACHE_KEY)) as GetRiskScoresResponse | null;
  if (stale) return stale;
  const emptyAux: AuxiliarySources = { ucdpEvents: [], outages: [], climate: [], cyber: [], fires: [], gpsHexes: [], iranEvents: [], orefData: null, advisories: null, displacedByIso3: {}, newsTopStories: [], threatSummaryByCountry: null };
  const ciiScores = computeCIIScores([], emptyAux);
  return { ciiScores, strategicRisks: computeStrategicRisks(ciiScores) };
}
