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

function averageDomainDimensionCoverage(domain: ResilienceDomain): number {
  if (domain.dimensions.length === 0) return 0;
  return domain.dimensions.reduce((sum, dim) => sum + dim.coverage, 0) / domain.dimensions.length;
}

export function buildPillarList(
  domains: ResilienceDomain[],
  schemaV2Enabled: boolean,
): ResiliencePillar[] {
  if (!schemaV2Enabled) return [];
  return PILLAR_ORDER.map((pillarId) => {
    const memberDomains = domains.filter((d) =>
      PILLAR_DOMAINS[pillarId].includes(d.id as ResilienceDomainId),
    );
    const domainCoverages = memberDomains.map((domain) => ({
      domain,
      coverage: averageDomainDimensionCoverage(domain),
    }));
    const totalCoverage = domainCoverages.reduce((sum, item) => sum + item.coverage, 0);
    const totalWeightedCoverage = domainCoverages.reduce((sum, item) => {
      return sum + item.domain.weight * item.coverage;
    }, 0);
    const pillarScore = totalWeightedCoverage > 0
      ? domainCoverages.reduce((sum, item) => {
          return sum + item.domain.score * item.domain.weight * item.coverage;
        }, 0) / totalWeightedCoverage
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
