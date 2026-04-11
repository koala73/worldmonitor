// Phase 2 T2.1 of the country-resilience reference-grade upgrade plan
// (docs/internal/country-resilience-upgrade-plan.md).
//
// Declarative pillar to domain membership for the three-pillar response
// shape. Single source of truth: PR 4 (T2.3) imports these constants
// for the real penalized-weighted-mean aggregation pass; this PR ships
// only the schema and the membership wiring with score=0, coverage=0.
//
// Pillar concept (from the plan, "Architecture target"):
//   - StructuralReadiness  = long-run institutional, economic, and
//                            infrastructure capacity. Slow-moving annual
//                            cadence sources.
//   - LiveShockExposure    = current shock pressure from health, energy,
//                            and other stress-cycle sources. Daily to
//                            weekly cadence.
//   - RecoveryCapacity     = fiscal space, reserves, surge capacity. NEW
//                            pillar composed in PR 3 / T2.2b once the
//                            recovery-capacity dimensions seed.
//
// Note on domain-id mapping. The plan example uses long-form names
// (StructuralReadiness, LiveShockExposure, RecoveryCapacity); the
// runtime ResilienceDomainId enum in `_dimension-scorers.ts` uses the
// kebab-case domain ids that already ship in the v1 response
// (`economic`, `infrastructure`, `energy`, `social-governance`,
// `health-food`). This module pins the mapping between the two so PR 4
// has a single import to consume.
//
// Membership invariants asserted by tests/resilience-pillar-schema.test.mts:
//   1. Every domain id listed here is a real ResilienceDomainId.
//   2. Pillar domain sets are pairwise disjoint (no domain in two pillars).
//   3. recovery-capacity is empty in this PR (PR 3 adds new dimensions
//      and PR 4 wires them through).
//   4. Weights sum to exactly 1.0 and match the plan defaults
//      (0.40 / 0.35 / 0.25).

import type { ResilienceDomain } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import type { ResilienceDomainId } from './_dimension-scorers';

export type ResiliencePillarId =
  | 'structural-readiness'
  | 'live-shock-exposure'
  | 'recovery-capacity';

// Pillar to domain membership. Recovery capacity ships empty in T2.1
// (this PR) and gets its real domain set wired in PR 3 / T2.2b after
// the new recovery-capacity dimensions seed. The two existing pillars
// partition the current 5 domains: structural-readiness owns the three
// long-run capacity domains, live-shock-exposure owns the two shock
// pressure domains.
export const PILLAR_DOMAINS: Readonly<Record<ResiliencePillarId, ReadonlyArray<ResilienceDomainId>>> = {
  'structural-readiness': ['economic', 'infrastructure', 'social-governance'],
  'live-shock-exposure': ['energy', 'health-food'],
  'recovery-capacity': [],
};

export const PILLAR_WEIGHTS: Readonly<Record<ResiliencePillarId, number>> = {
  'structural-readiness': 0.40,
  'live-shock-exposure': 0.35,
  'recovery-capacity': 0.25,
};

export const PILLAR_ORDER: ReadonlyArray<ResiliencePillarId> = [
  'structural-readiness',
  'live-shock-exposure',
  'recovery-capacity',
];

// Phase 2 T2.1: shaped-but-empty pillar list. PR 4 / T2.3 replaces the
// hardcoded 0 score / 0 coverage with the real penalized-weighted-mean
// aggregation. This helper is the single point that the v2 response
// branch calls; the v1 branch always returns `[]`.
//
// Filtering by membership preserves the input domain ordering so the
// pillar.domains array is deterministic and matches what
// CountryDeepDivePanel expects when it lights up in Phase 3 / T3.6.
export function buildPillarList(
  domains: ResilienceDomain[],
  schemaV2Enabled: boolean,
): {
  id: ResiliencePillarId;
  score: number;
  weight: number;
  coverage: number;
  domains: ResilienceDomain[];
}[] {
  if (!schemaV2Enabled) return [];
  return PILLAR_ORDER.map((pillarId) => {
    const memberSet = new Set<string>(PILLAR_DOMAINS[pillarId]);
    const memberDomains = domains.filter((domain) => memberSet.has(domain.id));
    return {
      id: pillarId,
      // T2.1 ships empty; PR 4 populates with the penalized weighted mean.
      score: 0,
      weight: PILLAR_WEIGHTS[pillarId],
      // T2.1 ships empty; PR 4 populates from the constituent domain
      // coverages once the aggregation pass lands.
      coverage: 0,
      domains: memberDomains,
    };
  });
}
