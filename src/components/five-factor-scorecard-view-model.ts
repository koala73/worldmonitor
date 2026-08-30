import type {
  FiveFactorPillar,
  ScorecardEvidence,
} from '@/generated/client/worldmonitor/scorecard/v1/service_client';

export const FIVE_FACTOR_PILLARS = ['food', 'energy', 'demographics', 'technology', 'defense'] as const;
export type FiveFactorPillarId = typeof FIVE_FACTOR_PILLARS[number];

export interface FiveFactorPillarLabels {
  insufficient: string;
  score: (value: number) => string;
  coverage: (value: number) => string;
}

export interface FiveFactorPillarRow {
  pillar: FiveFactorPillarId;
  status: 'scored' | 'insufficient';
  scoreLabel: string;
  coverageLabel: string;
  reasons: string[];
  inputs: ScorecardEvidence[];
}

export interface FormattedScorecardEvidence {
  inputId: string;
  available: boolean;
  valueLabel: string;
  provenance: string;
  unavailableReason: string;
}

function formatEvidenceValue(value: number, unit: string): string {
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (unit === 'percent') return `${formatted}%`;
  if (unit === 'ratio') return formatted;
  return unit ? `${formatted} ${unit}` : formatted;
}

export function buildFiveFactorPillarRows(
  pillars: FiveFactorPillar[],
  labels: FiveFactorPillarLabels,
): FiveFactorPillarRow[] {
  const byId = new Map(pillars.map((pillar) => [pillar.pillar, pillar]));
  return FIVE_FACTOR_PILLARS.map((pillar) => {
    const value = byId.get(pillar);
    const scored = value?.hasScore === true;
    return {
      pillar,
      status: scored ? 'scored' : 'insufficient',
      scoreLabel: scored ? labels.score(value.score) : labels.insufficient,
      coverageLabel: labels.coverage(Math.round((value?.inputCoverage ?? 0) * 100)),
      reasons: value?.insufficientReasons ?? ['pillar-unavailable'],
      inputs: value?.inputs ?? [],
    };
  });
}

export function formatScorecardEvidence(
  evidence: ScorecardEvidence,
  unavailableLabel: string,
): FormattedScorecardEvidence {
  const available = evidence.available && evidence.hasValue && Number.isFinite(evidence.value);
  const indicatorCodes = [...new Set(evidence.observations
    .map((observation) => observation.indicatorCode.trim())
    .filter(Boolean))];
  const provenanceParts = [evidence.source.trim(), ...indicatorCodes].filter(Boolean);
  return {
    inputId: evidence.inputId,
    available,
    valueLabel: available
      ? `${formatEvidenceValue(evidence.value, evidence.unit)}${evidence.year > 0 ? ` · ${evidence.year}` : ''}`
      : unavailableLabel,
    provenance: provenanceParts.join(' · '),
    unavailableReason: available ? '' : evidence.unavailableReason,
  };
}
