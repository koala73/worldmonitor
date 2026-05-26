import type { WarRiskTier } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

export type ThreatLevel = 'war_zone' | 'critical' | 'high' | 'elevated' | 'normal';

/**
 * Maps a chokepoint threat level to a war risk insurance premium in basis points (bps).
 * Based on Lloyd's JWC Listed Areas and live H&M/P&I market rates.
 * PRO-only: returned only as part of get-country-cost-shock response.
 */
export function threatLevelToInsurancePremiumBps(threatLevel: ThreatLevel): number {
  switch (threatLevel) {
    case 'war_zone':  return 300;  // 3.0% additional premium
    case 'critical':  return 100;  // 1.0%
    case 'high':      return 50;   // 0.5%
    case 'elevated':  return 20;   // 0.2%
    case 'normal':    return 5;    // 0.05%
    default: {
      ((_: never) => {})(threatLevel);
      return 5;
    }
  }
}

/**
 * Direct tier string → insurance premium bps (no ThreatLevel intermediate).
 * Use in handlers where warRiskTier is read directly from Redis.
 */
export function warRiskTierToInsurancePremiumBps(tier: string): number {
  switch (tier) {
    case 'WAR_RISK_TIER_WAR_ZONE':  return 300;
    case 'WAR_RISK_TIER_CRITICAL':  return 100;
    case 'WAR_RISK_TIER_HIGH':      return 50;
    case 'WAR_RISK_TIER_ELEVATED':  return 20;
    default:                        return 5;
  }
}

/**
 * Maps ThreatLevel (internal) → WarRiskTier proto enum string.
 * Canonical mapping used by get-chokepoint-status and supply-chain handlers.
 */
export function threatLevelToWarRiskTier(tl: ThreatLevel): WarRiskTier {
  switch (tl) {
    case 'war_zone':  return 'WAR_RISK_TIER_WAR_ZONE';
    case 'critical':  return 'WAR_RISK_TIER_CRITICAL';
    case 'high':      return 'WAR_RISK_TIER_HIGH';
    case 'elevated':  return 'WAR_RISK_TIER_ELEVATED';
    case 'normal':    return 'WAR_RISK_TIER_NORMAL';
    default: {
      ((_: never) => {})(tl);
      return 'WAR_RISK_TIER_NORMAL';
    }
  }
}

/**
 * Tier rank for sorting/comparing war risk tiers. Higher = more severe.
 * Exported here so handlers don't allocate it inline on every request.
 */
export const TIER_RANK: Record<string, number> = {
  WAR_RISK_TIER_WAR_ZONE: 5,
  WAR_RISK_TIER_CRITICAL: 4,
  WAR_RISK_TIER_HIGH: 3,
  WAR_RISK_TIER_ELEVATED: 2,
  WAR_RISK_TIER_NORMAL: 1,
  WAR_RISK_TIER_UNSPECIFIED: 0,
};
