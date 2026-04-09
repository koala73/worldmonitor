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
  }
}
