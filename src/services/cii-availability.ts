import type { CachedRiskScores } from './cached-risk-scores';

export interface CiiAvailabilityTransition {
  nextState: CachedRiskScores | null;
  render: 'cached' | 'unavailable' | null;
  refreshBrief: boolean;
}

export function transitionCiiAvailability(
  previousState: CachedRiskScores | null | undefined,
  cached: CachedRiskScores | null,
): CiiAvailabilityTransition {
  if (cached) {
    return {
      nextState: cached,
      render: previousState === cached ? null : 'cached',
      refreshBrief: true,
    };
  }

  const alreadyUnavailable = previousState === null;
  return {
    nextState: null,
    render: alreadyUnavailable ? null : 'unavailable',
    refreshBrief: !alreadyUnavailable,
  };
}
