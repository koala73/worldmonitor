import type {
  CategoryBreakdown,
  GivingProvenance,
  GivingSummary,
  PlatformGiving,
} from '../../../../src/generated/server/worldmonitor/giving/v1/service_server';
import publishedEstimateClaims from '../../../../scripts/shared/giving-published-estimate-claims.json';

export const GIVING_PROVENANCE_STATUSES = [
  'verified',
  'partially_verified',
  'unverified',
  'not_collected',
  'not_applicable',
] as const;

export type GivingProvenanceStatus = (typeof GIVING_PROVENANCE_STATUSES)[number];

type PlatformName = 'GoFundMe' | 'GlobalGiving' | 'JustGiving';
type ContextMetric = 'oecd_oda_usd_bn' | 'candid_grants' | 'candid_annual_usd' | 'caf_index';

export interface PublishedEstimateClaim extends GivingProvenance {
  status: string;
  platform?: PlatformName;
  contextMetric?: ContextMetric;
}

const DAYS_PER_YEAR = 365;

export function normalizeGivingStatus(status: string): GivingProvenanceStatus {
  return (GIVING_PROVENANCE_STATUSES as readonly string[]).includes(status)
    ? status as GivingProvenanceStatus
    : 'unverified';
}

// Claim-level source registry. `notes` preserves the exact source or legacy
// claim because the additive public provenance contract intentionally has no
// separate free-form exact_claim field.
export const PUBLISHED_ESTIMATE_CLAIMS =
  publishedEstimateClaims as readonly PublishedEstimateClaim[];

function annualizedPlatformValueUsd(claim: PublishedEstimateClaim): number | undefined {
  if (
    !claim.platform
    || !claim.includedInHighlightedAggregate
    || normalizeGivingStatus(claim.status) !== 'verified'
    || claim.reportedUnit !== 'USD'
    || !Number.isFinite(claim.reportedValue)
    || claim.reportedValue <= 0
  ) {
    return undefined;
  }
  if (claim.denominator === 'year') return claim.reportedValue;
  if (claim.denominator === 'week') return claim.reportedValue * 52;
  return undefined;
}

function verifiedPublicationDate(claims: readonly PublishedEstimateClaim[], platform: PlatformName): string {
  return claims.find((claim) =>
    claim.platform === platform
    && normalizeGivingStatus(claim.status) === 'verified'
    && claim.sourcePublishedAt.trim())?.sourcePublishedAt ?? '';
}

function platformProjection(
  claims: readonly PublishedEstimateClaim[],
  platform: PlatformName,
  dataFreshness: 'annual' | 'cumulative',
): PlatformGiving {
  const annualizedUsd = claims
    .filter((claim) => claim.platform === platform)
    .reduce((total, claim) => total + (annualizedPlatformValueUsd(claim) ?? 0), 0);
  return {
    platform,
    dailyVolumeUsd: annualizedUsd / DAYS_PER_YEAR,
    activeCampaignsSampled: 0,
    newCampaigns24h: 0,
    donationVelocity: 0,
    dataFreshness,
    lastUpdated: verifiedPublicationDate(claims, platform),
  };
}

function verifiedContextValue(
  claims: readonly PublishedEstimateClaim[],
  metric: ContextMetric,
): number {
  const claim = claims.find((entry) => entry.contextMetric === metric);
  return claim && normalizeGivingStatus(claim.status) === 'verified'
    ? claim.reportedValue
    : 0;
}

function categoryProjections(): CategoryBreakdown[] {
  return [
    'Medical & Health',
    'Disaster Relief',
    'Education',
    'Community',
    'Memorials',
    'Animals & Pets',
    'Environment',
    'Hunger & Food',
    'Other',
  ].map((category) => ({
    category,
    share: 0,
    change24h: 0,
    activeCampaigns: 0,
    trending: false,
  }));
}

function publicProvenance(claim: PublishedEstimateClaim): GivingProvenance {
  return {
    subject: claim.subject,
    sourceName: claim.sourceName,
    sourceUrl: claim.sourceUrl,
    referencePeriod: claim.referencePeriod,
    sourcePublishedAt: claim.sourcePublishedAt,
    measurementBasis: claim.measurementBasis,
    status: normalizeGivingStatus(claim.status),
    coveredMetricPaths: [...claim.coveredMetricPaths],
    includedInHighlightedAggregate: claim.includedInHighlightedAggregate,
    reportedValue: claim.reportedValue,
    reportedUnit: claim.reportedUnit,
    notes: claim.notes,
    valueQualifier: claim.valueQualifier,
    sourceLocator: claim.sourceLocator,
    accessedAt: claim.accessedAt,
    denominator: claim.denominator,
    derivation: claim.derivation,
  };
}

function dataMode(claims: readonly PublishedEstimateClaim[]): 'published_estimate' | 'partial_estimate' {
  return claims.some((claim) => {
    const status = normalizeGivingStatus(claim.status);
    return status === 'unverified' || status === 'partially_verified';
  })
    ? 'partial_estimate'
    : 'published_estimate';
}

export function buildPublishedEstimateSummary(
  claims: readonly PublishedEstimateClaim[] = PUBLISHED_ESTIMATE_CLAIMS,
  generatedAt = new Date().toISOString(),
): GivingSummary {
  const platforms = [
    platformProjection(claims, 'GoFundMe', 'annual'),
    platformProjection(claims, 'GlobalGiving', 'annual'),
    platformProjection(claims, 'JustGiving', 'cumulative'),
  ];
  const estimatedDailyFlowUsd = platforms.reduce((total, platform) => total + platform.dailyVolumeUsd, 0);
  const oecdOdaAnnualUsdBn = verifiedContextValue(claims, 'oecd_oda_usd_bn');

  return {
    generatedAt,
    activityIndex: 0,
    trend: 'stable',
    estimatedDailyFlowUsd,
    platforms,
    categories: categoryProjections(),
    crypto: {
      dailyInflowUsd: 0,
      trackedWallets: 0,
      transactions24h: 0,
      topReceivers: [],
      pctOfTotal: 0,
    },
    institutional: {
      oecdOdaAnnualUsdBn,
      oecdDataYear: oecdOdaAnnualUsdBn > 0 ? 2023 : 0,
      cafWorldGivingIndex: 0,
      cafDataYear: 0,
      candidGrantsTracked: verifiedContextValue(claims, 'candid_grants'),
      dataLag: 'Annual published context',
    },
    dataMode: dataMode(claims),
    trendAvailable: false,
    provenance: claims.map(publicProvenance),
    activityIndexAvailable: false,
  };
}
