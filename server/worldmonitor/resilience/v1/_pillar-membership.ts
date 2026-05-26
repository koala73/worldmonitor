import type { ResilienceDomain } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import type { ResilienceDomainId } from './_dimension-scorers';

export type ResiliencePillarId = 'structural-readiness' | 'live-shock-exposure' | 'recovery-capacity';

export interface ResiliencePillar {
  id: ResiliencePillarId;
  score: number;
  weight: number;
  coverage: number;
  domains: ResilienceDomain[];
}

export const PILLAR_DOMAINS: Record<ResiliencePillarId, ResilienceDomainId[]> = {
  'structural-readiness': ['economic', 'social-governance'],
  'live-shock-exposure': ['infrastructure', 'energy', 'health-food'],
  'recovery-capacity': ['recovery'],
};

export const PILLAR_WEIGHTS: Record<ResiliencePillarId, number> = {
  'structural-readiness': 0.40,
  'live-shock-exposure': 0.35,
  'recovery-capacity': 0.25,
};

export const PILLAR_ORDER: ResiliencePillarId[] = [
  'structural-readiness',
  'live-shock-exposure',
  'recovery-capacity',
];

export function buildPillarList(
  domains: ResilienceDomain[],
  schemaV2Enabled: boolean,
): ResiliencePillar[] {
  if (!schemaV2Enabled) return [];
  return PILLAR_ORDER.map((pillarId) => {
    const memberDomains = domains.filter((d) =>
      PILLAR_DOMAINS[pillarId].includes(d.id as ResilienceDomainId),
    );
    const totalCoverage = memberDomains.reduce((sum, d) => {
      const dimCoverages = d.dimensions.map((dim) => dim.coverage);
      return sum + (dimCoverages.length > 0 ? dimCoverages.reduce((a, b) => a + b, 0) / dimCoverages.length : 0);
    }, 0);
    const pillarScore = totalCoverage > 0
      ? memberDomains.reduce((sum, d) => {
          const avgCoverage = d.dimensions.length > 0
            ? d.dimensions.reduce((a, dim) => a + dim.coverage, 0) / d.dimensions.length
            : 0;
          return sum + d.score * avgCoverage;
        }, 0) / totalCoverage
      : 0;
    const pillarCoverage = memberDomains.length > 0
      ? totalCoverage / memberDomains.length
      : 0;

    return {
      id: pillarId,
      score: Math.round(pillarScore * 100) / 100,
      weight: PILLAR_WEIGHTS[pillarId],
      coverage: Math.round(pillarCoverage * 10000) / 10000,
      domains: memberDomains,
    };
  });
}
