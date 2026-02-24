import type {
  ServerContext,
  GetRiskScoresRequest,
  GetRiskScoresResponse,
  CiiScore,
  StrategicRisk,
  TrendDirection,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { TIER1_COUNTRIES } from './_shared';
import { fetchAcledCached } from '../../../_shared/acled';

// ========================================================================
// Country risk baselines and multipliers
// ========================================================================

const BASELINE_RISK: Record<string, number> = {
  US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45,
  SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35,
  SY: 50, YE: 50, MM: 45, VE: 40,
};

const EVENT_MULTIPLIER: Record<string, number> = {
  US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0,
  SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5,
  SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8,
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

interface AcledEvent {
  country: string;
  event_type: string;
}

async function fetchACLEDProtests(): Promise<AcledEvent[]> {
  const endDate = new Date().toISOString().split('T')[0]!;
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
  const raw = await fetchAcledCached({
    eventTypes: 'Protests|Riots',
    startDate,
    endDate,
  });
  return raw.map((e) => ({ country: e.country || '', event_type: e.event_type || '' }));
}

function computeCIIScores(protests: AcledEvent[]): CiiScore[] {
  const countryEvents = new Map<string, { protests: number; riots: number }>();
  for (const event of protests) {
    const code = normalizeCountryName(event.country);
    if (code && TIER1_COUNTRIES[code]) {
      const count = countryEvents.get(code) || { protests: 0, riots: 0 };
      if (event.event_type === 'Riots') count.riots++;
      else count.protests++;
      countryEvents.set(code, count);
    }
  }

  const scores: CiiScore[] = [];
  for (const [code, _name] of Object.entries(TIER1_COUNTRIES)) {
    const events = countryEvents.get(code) || { protests: 0, riots: 0 };
    const baseline = BASELINE_RISK[code] || 20;
    const multiplier = EVENT_MULTIPLIER[code] || 1.0;
    const unrest = Math.min(100, Math.round((events.protests + events.riots * 2) * multiplier * 2));
    const security = Math.min(100, baseline + events.riots * multiplier * 5);
    const information = Math.min(100, (events.protests + events.riots) * multiplier * 3);
    const composite = Math.min(100, Math.round(baseline + (unrest * 0.4 + security * 0.35 + information * 0.25) * 0.5));

    scores.push({
      region: code,
      staticBaseline: baseline,
      dynamicScore: composite - baseline,
      combinedScore: composite,
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
      components: {
        newsActivity: information,
        ciiContribution: unrest,
        geoConvergence: 0,
        militaryActivity: 0,
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
  // Check cache
  const cached = (await getCachedJson(RISK_CACHE_KEY)) as GetRiskScoresResponse | null;
  if (cached) return cached;

  try {
    const protests = await fetchACLEDProtests();
    const ciiScores = computeCIIScores(protests);
    const strategicRisks = computeStrategicRisks(ciiScores);
    const result: GetRiskScoresResponse = { ciiScores, strategicRisks };

    await Promise.all([
      setCachedJson(RISK_CACHE_KEY, result, RISK_CACHE_TTL),
      setCachedJson(RISK_STALE_CACHE_KEY, result, RISK_STALE_TTL),
    ]);
    return result;
  } catch {
    const stale = (await getCachedJson(RISK_STALE_CACHE_KEY)) as GetRiskScoresResponse | null;
    if (stale) return stale;
    // Baseline fallback
    const ciiScores = computeCIIScores([]);
    return { ciiScores, strategicRisks: computeStrategicRisks(ciiScores) };
  }
}
