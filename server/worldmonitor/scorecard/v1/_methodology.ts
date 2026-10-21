// Generated from scripts/scorecard/v1/_methodology.mts by scripts/generate-scorecard-edge-mirrors.mjs. Do not edit.
import type { ScorecardPillar } from './_types';

export const SCORECARD_METHODOLOGY_VERSION = '1.0.0' as const;

export const SCORECARD_PILLAR_RULES: Record<ScorecardPillar, {
  coverageFloor: number;
  requiredGroups: string[][];
}> = {
  food: { coverageFloor: 0.7, requiredGroups: [['balance']] },
  energy: { coverageFloor: 0.6, requiredGroups: [['balance']] },
  demographics: { coverageFloor: 0.6, requiredGroups: [['age'], ['capability']] },
  technology: { coverageFloor: 0.65, requiredGroups: [['connectivity'], ['innovation']] },
  defense: { coverageFloor: 0.5, requiredGroups: [['posture'], ['industry']] },
};

export const SCORECARD_BAND_LABELS = {
  1: 'severe-deficit',
  2: 'material-deficit',
  3: 'mixed-capability',
  4: 'strong-capability',
  5: 'high-capability',
} as const;
