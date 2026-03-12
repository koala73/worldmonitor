export type HubActivityLevel = 'high' | 'elevated' | 'low';
export type HubTrend = 'rising' | 'stable' | 'falling';

export function normalizeHubScore(rawScore: number, maxRawScore: number): number {
  if (maxRawScore <= 0) return 0;
  return Math.round((rawScore / maxRawScore) * 100);
}

export function deriveHubActivityLevel(score: number, hasBreaking: boolean): HubActivityLevel {
  if (score >= 70 || hasBreaking) {
    return 'high';
  }
  if (score >= 40) {
    return 'elevated';
  }
  return 'low';
}

export function deriveHubTrend(totalVelocity: number, newsCount: number): HubTrend {
  if (totalVelocity > 2) {
    return 'rising';
  }
  if (totalVelocity < 0.5 && newsCount > 1) {
    return 'falling';
  }
  return 'stable';
}
