import type {
  ServerContext,
  GetRiskScoresRequest,
  GetRiskScoresResponse,
  CiiScore,
  StrategicRisk,
  TrendDirection,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { TIER1_COUNTRIES } from './_shared';

const BASELINE_RISK: Record<string, number> = {
  US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45,
  SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35,
  SY: 50, YE: 50, MM: 45, VE: 40,
};

function computeBaselineScores(): CiiScore[] {
  const scores: CiiScore[] = [];
  for (const [code] of Object.entries(TIER1_COUNTRIES)) {
    const baseline = BASELINE_RISK[code] || 20;
    scores.push({
      region: code,
      staticBaseline: baseline,
      dynamicScore: 0,
      combinedScore: baseline,
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
      components: { newsActivity: 0, ciiContribution: 0, geoConvergence: 0, militaryActivity: 0 },
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

const RISK_CACHE_KEY = 'risk:scores:sebuf:v1';
const RISK_STALE_CACHE_KEY = 'risk:scores:sebuf:stale:v1';

function isValidResponse(data: unknown): data is GetRiskScoresResponse {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.ciiScores) || d.ciiScores.length === 0) return false;
  for (const s of d.ciiScores) {
    if (!s || typeof s !== 'object') return false;
    const sc = s as Record<string, unknown>;
    if (typeof sc.region !== 'string' || !Number.isFinite(sc.combinedScore)) return false;
    if ((sc.combinedScore as number) < 0 || (sc.combinedScore as number) > 100) return false;
  }
  return true;
}

export async function getRiskScores(
  _ctx: ServerContext,
  _req: GetRiskScoresRequest,
): Promise<GetRiskScoresResponse> {
  const cached = await getCachedJson(RISK_CACHE_KEY);
  if (isValidResponse(cached)) return cached;

  const stale = await getCachedJson(RISK_STALE_CACHE_KEY);
  if (isValidResponse(stale)) return stale;

  const ciiScores = computeBaselineScores();
  return { ciiScores, strategicRisks: computeStrategicRisks(ciiScores) };
}
