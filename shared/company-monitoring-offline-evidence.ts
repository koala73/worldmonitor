import {
  normalizeCompanyEvidence,
  type NormalizedCompanyEvidence,
  type ProviderEvidence,
} from './company-monitoring-evidence.ts';
import {
  CompanyMonitoringOfflinePredictionError,
  type OfflineProviderObservation,
  type OfflineProviderObservationManifest,
} from './company-monitoring-offline-prediction-contracts.ts';
import type { CompanyMonitoringCurationManifest } from './company-monitoring-curation.ts';

export function validateOfflineFirstPartyIdentityBindings(
  curationById: Map<string, CompanyMonitoringCurationManifest['candidates'][number]>,
  observations: OfflineProviderObservationManifest,
): void {
  for (const row of observations.rows) {
    const curatorCandidate = curationById.get(row.opaqueExampleId);
    if (!curatorCandidate) {
      throw new CompanyMonitoringOfflinePredictionError('offline_curation_membership_mismatch');
    }
    const officialDomains = new Set(curatorCandidate.company.officialDomains);
    const verifiedAccountIds = new Set(curatorCandidate.company.verifiedXAccountIds);
    for (const observation of row.evidence) {
      if (!observation.verifiedCompany) continue;
      const bound = observation.provider === 'exa'
        ? observation.officialCompanyDomain !== null &&
          officialDomains.has(observation.officialCompanyDomain)
        : observation.authorAccountId !== null &&
          verifiedAccountIds.has(observation.authorAccountId);
      if (!bound) {
        throw new CompanyMonitoringOfflinePredictionError(
          'offline_observation_identity_binding_mismatch',
        );
      }
    }
  }
}

function providerEvidence(
  observation: OfflineProviderObservation,
  companyId: string,
): ProviderEvidence {
  return {
    provider: observation.provider,
    providerLocator: observation.providerLocator,
    queryVersion: observation.queryVersion,
    url: observation.url,
    ...(observation.title === null ? {} : { title: observation.title }),
    ...(observation.text === null ? {} : { text: observation.text }),
    ...(observation.author === null ? {} : { author: observation.author }),
    ...(observation.authorAccountId === null ? {} : { authorAccountId: observation.authorAccountId }),
    publishedAt: observation.publishedAt,
    observedAt: observation.observedAt,
    ...(observation.expiresAt === null ? {} : { expiresAt: observation.expiresAt }),
    candidateCompanyIds: [companyId],
    ...(observation.verifiedCompany ? { verifiedCompanyIds: [companyId] } : {}),
    sourceAuthority: observation.sourceAuthority,
  };
}

export async function normalizeOfflineEvaluationEvidence(
  opaqueExampleId: string,
  legalName: string,
  observations: OfflineProviderObservation[],
  capturedAt: number,
  occurrenceDigest: string,
): Promise<NormalizedCompanyEvidence[]> {
  const companyId = `cm_eval_company_${opaqueExampleId.slice('cm_example_'.length)}`;
  const officialDomains = [...new Set(observations.flatMap((observation) =>
    observation.officialCompanyDomain === null ? [] : [observation.officialCompanyDomain]
  ))].sort();
  const normalized = await normalizeCompanyEvidence({
    ownerAccountId: 'cm_eval_account',
    subjects: [{
      companyId,
      name: legalName,
      claims: [{
        claimId: 'cm_eval_legal_name',
        type: 'alias',
        value: legalName,
        trustState: 'verified',
        allowedUses: ['discovery', 'attribution'],
      }, ...officialDomains.map((domain, index) => ({
        claimId: `cm_eval_official_domain_${index + 1}`,
        type: 'domain' as const,
        value: domain,
        trustState: 'verified' as const,
        allowedUses: ['discovery', 'attribution'] as const,
      }))],
    }],
    evidence: observations.map((observation) => providerEvidence(observation, companyId)),
    now: capturedAt,
  });
  const observationByLocator = new Map(observations.map((observation) => [
    `${observation.provider}\u0000${observation.providerLocator}`,
    observation,
  ]));
  const groupOrigins = new Map<string, Set<string>>();
  for (const evidence of normalized.evidence) {
    const observation = observationByLocator.get(`${evidence.provider}\u0000${evidence.providerLocator}`)!;
    if (observation.syndication.relationship !== 'independent') continue;
    const origins = groupOrigins.get(observation.syndication.groupIdentity) ?? new Set<string>();
    origins.add(observation.publisherOrigin);
    groupOrigins.set(observation.syndication.groupIdentity, origins);
  }
  return normalized.evidence.map((evidence) => {
    const observation = observationByLocator.get(`${evidence.provider}\u0000${evidence.providerLocator}`)!;
    const independence = observation.verifiedCompany && evidence.independence === 'first_party'
      ? 'first_party'
      : observation.syndication.relationship === 'independent' &&
          groupOrigins.get(observation.syndication.groupIdentity)?.size === 1
        ? 'independent'
        : observation.syndication.relationship === 'syndicated'
          ? 'syndicated'
          : 'unknown';
    return { ...evidence, independence, occurrenceDedupeKey: occurrenceDigest };
  });
}
