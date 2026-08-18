export interface CorridorRiskNameMapping {
  pattern: string;
  id: string;
}

export const CORRIDOR_RISK_NAME_MAP: readonly CorridorRiskNameMapping[];

export function deriveCorridorRiskLevel(
  score: number,
): 'critical' | 'high' | 'elevated' | 'normal';
