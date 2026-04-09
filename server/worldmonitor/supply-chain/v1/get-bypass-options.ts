import type {
  ServerContext,
  GetBypassOptionsRequest,
  GetBypassOptionsResponse,
  BypassOption,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../../../../src/config/bypass-corridors';
import { getCachedJson } from '../../../_shared/redis';

export async function getBypassOptions(
  ctx: ServerContext,
  req: GetBypassOptionsRequest,
): Promise<GetBypassOptionsResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetBypassOptionsResponse = {
    chokepointId: req.chokepointId,
    cargoType: req.cargoType || 'container',
    closurePct: req.closurePct || 100,
    options: [],
    fetchedAt: new Date().toISOString(),
  };
  if (!isPro) return empty;

  const chokepointId = req.chokepointId?.trim().toLowerCase();
  if (!chokepointId) return empty;

  const cargoType = (req.cargoType?.trim().toLowerCase() || 'container') as 'container' | 'tanker' | 'bulk' | 'roro';
  const closurePct = Math.max(0, Math.min(100, req.closurePct ?? 100));

  const corridors = BYPASS_CORRIDORS_BY_CHOKEPOINT[chokepointId] ?? [];

  const relevant = corridors.filter(c => {
    if (c.suitableCargoTypes.length === 0) return false;
    if (!c.suitableCargoTypes.includes(cargoType)) return false;
    if (closurePct < 100 && c.activationThreshold === 'full_closure') return false;
    return true;
  });

  type ChokepointStatusCacheEntry = { id: string; warRiskTier?: string; disruptionScore?: number };
  const statusRaw = await getCachedJson('supply_chain:chokepoints:v4').catch(() => null) as { chokepoints?: ChokepointStatusCacheEntry[] } | null;
  const tierMap: Record<string, string> = {};
  const scoreMap: Record<string, number> = {};
  for (const cp of statusRaw?.chokepoints ?? []) {
    if (cp.warRiskTier) tierMap[cp.id] = cp.warRiskTier;
    if (typeof cp.disruptionScore === 'number') scoreMap[cp.id] = cp.disruptionScore;
  }

  const TIER_RANK: Record<string, number> = {
    WAR_RISK_TIER_WAR_ZONE: 5, WAR_RISK_TIER_CRITICAL: 4, WAR_RISK_TIER_HIGH: 3,
    WAR_RISK_TIER_ELEVATED: 2, WAR_RISK_TIER_NORMAL: 1, WAR_RISK_TIER_UNSPECIFIED: 0,
  };

  const options: BypassOption[] = relevant.map(c => {
    const waypointScores = c.waypointChokepointIds.map(id => scoreMap[id] ?? 0);
    const avgWaypointScore = waypointScores.length > 0
      ? waypointScores.reduce((a, b) => a + b, 0) / waypointScores.length
      : 0;
    const liveScore = Math.min(100, avgWaypointScore * 0.6 + (c.addedCostMultiplier - 1) * 100 * 0.4);

    const maxTierKey = c.waypointChokepointIds.reduce<string>((best, id) => {
      const t = tierMap[id] ?? 'WAR_RISK_TIER_UNSPECIFIED';
      return (TIER_RANK[t] ?? 0) > (TIER_RANK[best] ?? 0) ? t : best;
    }, 'WAR_RISK_TIER_UNSPECIFIED');

    return {
      id: c.id,
      name: c.name,
      type: c.type,
      addedTransitDays: c.addedTransitDays,
      addedCostMultiplier: c.addedCostMultiplier,
      capacityConstraintTonnage: String(c.capacityConstraintTonnage ?? 0),
      suitableCargoTypes: [...c.suitableCargoTypes],
      activationThreshold: c.activationThreshold,
      waypointChokepointIds: [...c.waypointChokepointIds],
      liveScore: Math.round(liveScore * 10) / 10,
      bypassWarRiskTier: maxTierKey as BypassOption['bypassWarRiskTier'],
      notes: c.notes,
    };
  });

  options.sort((a, b) => a.liveScore - b.liveScore);

  return {
    chokepointId,
    cargoType,
    closurePct,
    options,
    fetchedAt: new Date().toISOString(),
  };
}
