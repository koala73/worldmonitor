import type {
  CategoryBreakdown as ProtoCategory,
  CryptoGivingSummary as ProtoCrypto,
  GetGivingSummaryResponse as ProtoResponse,
  GivingProvenance as ProtoProvenance,
  InstitutionalGiving as ProtoInstitutional,
  PlatformGiving as ProtoPlatform,
} from '../../generated/client/worldmonitor/giving/v1/service_client';

export type GivingDataMode = 'published_estimate' | 'partial_estimate';
export type GivingAvailability =
  | 'available'
  | 'available-but-partial'
  | 'available-but-legacy'
  | 'cached-refresh-unavailable'
  | 'unavailable';
export type GivingRefreshFailure = 'transport' | 'unavailable' | 'legacy';
export type GivingProvenanceStatus =
  | 'verified'
  | 'partially_verified'
  | 'unverified'
  | 'not_collected'
  | 'not_applicable';

export interface GivingProvenance {
  subject: string;
  sourceName: string;
  sourceUrl: string;
  referencePeriod: string;
  sourcePublishedAt: string;
  measurementBasis: string;
  status: GivingProvenanceStatus;
  coveredMetricPaths: string[];
  includedInHighlightedAggregate: boolean;
  reportedValue: number;
  reportedUnit: string;
  notes: string;
  valueQualifier: string;
  sourceLocator: string;
  accessedAt: string;
  denominator: string;
  derivation: string;
}

export interface PlatformGiving {
  platform: string;
  dailyVolumeUsd: number;
  activeCampaignsSampled: number;
  newCampaigns24h: number;
  donationVelocity: number;
  dataFreshness: string;
  lastUpdated: string;
}

export interface CategoryBreakdown {
  category: string;
  share: number;
  change24h: number;
  activeCampaigns: number;
  trending: boolean;
}

export interface CryptoGivingSummary {
  dailyInflowUsd: number;
  trackedWallets: number;
  transactions24h: number;
  topReceivers: string[];
  pctOfTotal: number;
}

export interface InstitutionalGiving {
  oecdOdaAnnualUsdBn: number;
  oecdDataYear: number;
  cafWorldGivingIndex: number;
  cafDataYear: number;
  candidGrantsTracked: number;
  dataLag: string;
}

export interface GivingSummary {
  generatedAt: string;
  materializedAt: string;
  availability: GivingAvailability;
  refreshFailure: GivingRefreshFailure | null;
  activityIndex: number;
  activityIndexAvailable: boolean;
  trend: string;
  trendAvailable: boolean;
  estimatedDailyFlowUsd: number;
  platforms: PlatformGiving[];
  categories: CategoryBreakdown[];
  crypto: CryptoGivingSummary;
  institutional: InstitutionalGiving;
  dataMode: GivingDataMode | 'legacy';
  provenance: GivingProvenance[];
}

export interface GivingFetchResult {
  ok: boolean;
  data: GivingSummary;
  state: GivingAvailability;
  cachedAt?: string;
  refreshFailure?: GivingRefreshFailure;
}

export interface GivingSnapshot {
  data: GivingSummary;
  materializedAt: number;
}

export type GivingClassification =
  | { kind: 'v2'; snapshot: GivingSnapshot }
  | { kind: 'legacy'; data: GivingSummary; snapshot?: undefined }
  | { kind: 'unavailable'; snapshot?: undefined };

export type GivingHydrationSource = 'live' | 'cached' | 'mixed' | 'none';

export interface GivingHydrationResolution {
  lastGood: GivingSnapshot | null;
  immediateResult: GivingFetchResult | null;
  refreshFailure: GivingRefreshFailure | null;
}

export const GIVING_STALE_CEILING_MS = 24 * 60 * 60 * 1000;
export const GIVING_BREAKER_CACHE_KEY = 'v2';
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_PROVENANCE_ENTRIES = 256;
const MAX_COVERED_METRIC_PATHS = 64;
const MAX_PROVENANCE_STRING_LENGTH = 20_000;
const MAX_METRIC_PATH_LENGTH = 512;
const MAX_PLATFORM_ENTRIES = 64;
const MAX_CATEGORY_ENTRIES = 128;
const GIVING_DATA_MODES = new Set<GivingDataMode>(['published_estimate', 'partial_estimate']);
const GIVING_PROVENANCE_STATUSES = new Set<GivingProvenanceStatus>([
  'verified',
  'partially_verified',
  'unverified',
  'not_collected',
  'not_applicable',
]);

export const EMPTY_PROTO_RESPONSE: ProtoResponse = {
  summary: undefined,
  fetchedAt: 0,
  dataAvailable: false,
};

export const emptyResult: GivingSummary = {
  generatedAt: '',
  materializedAt: '',
  availability: 'unavailable',
  refreshFailure: null,
  activityIndex: 0,
  activityIndexAvailable: false,
  trend: '',
  trendAvailable: false,
  estimatedDailyFlowUsd: 0,
  platforms: [],
  categories: [],
  crypto: {
    dailyInflowUsd: 0,
    trackedWallets: 0,
    transactions24h: 0,
    topReceivers: [],
    pctOfTotal: 0,
  },
  institutional: {
    oecdOdaAnnualUsdBn: 0,
    oecdDataYear: 0,
    cafWorldGivingIndex: 0,
    cafDataYear: 0,
    candidGrantsTracked: 0,
    dataLag: '',
  },
  dataMode: 'legacy',
  provenance: [],
};

function normalizeGivingStatus(status: string): GivingProvenanceStatus {
  return GIVING_PROVENANCE_STATUSES.has(status as GivingProvenanceStatus)
    ? status as GivingProvenanceStatus
    : 'unverified';
}

function responseMaterializedAt(response: ProtoResponse): number {
  if (Number.isFinite(response.fetchedAt) && response.fetchedAt > 0) return response.fetchedAt;
  const parsed = response.summary?.generatedAt ? Date.parse(response.summary.generatedAt) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isUsableMaterializationTime(timestamp: number, now: number): boolean {
  return timestamp > 0
    && timestamp <= now + MAX_FUTURE_SKEW_MS
    && now - timestamp <= GIVING_STALE_CEILING_MS;
}

function isBoundedString(value: unknown, maxLength = MAX_PROVENANCE_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isValidGivingProvenance(value: unknown): value is ProtoProvenance {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const stringFields = [
    'subject',
    'sourceName',
    'sourceUrl',
    'referencePeriod',
    'sourcePublishedAt',
    'measurementBasis',
    'status',
    'reportedUnit',
    'notes',
    'valueQualifier',
    'sourceLocator',
    'accessedAt',
    'denominator',
    'derivation',
  ];
  if (!stringFields.every((field) => isBoundedString(entry[field]))) return false;

  const paths = entry.coveredMetricPaths;
  if (
    !Array.isArray(paths)
    || paths.length === 0
    || paths.length > MAX_COVERED_METRIC_PATHS
    || !paths.every((path) => isBoundedString(path, MAX_METRIC_PATH_LENGTH))
  ) {
    return false;
  }

  return typeof entry.includedInHighlightedAggregate === 'boolean'
    && typeof entry.reportedValue === 'number'
    && Number.isFinite(entry.reportedValue)
    && Math.abs(entry.reportedValue) <= Number.MAX_SAFE_INTEGER;
}

function hasValidGivingProvenance(value: unknown): value is ProtoProvenance[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_PROVENANCE_ENTRIES
    && value.every(isValidGivingProvenance);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidPlatform(value: unknown): value is ProtoPlatform {
  if (typeof value !== 'object' || value === null) return false;
  const platform = value as Record<string, unknown>;
  return isBoundedString(platform.platform, 256)
    && isFiniteNumber(platform.dailyVolumeUsd)
    && isFiniteNumber(platform.activeCampaignsSampled)
    && isFiniteNumber(platform.newCampaigns24h)
    && isFiniteNumber(platform.donationVelocity)
    && isBoundedString(platform.dataFreshness, 64)
    && isBoundedString(platform.lastUpdated, 128);
}

function hasValidPlatforms(value: unknown): value is ProtoPlatform[] {
  return Array.isArray(value)
    && value.length <= MAX_PLATFORM_ENTRIES
    && value.every(isValidPlatform);
}

function isValidCategory(value: unknown): value is ProtoCategory {
  if (typeof value !== 'object' || value === null) return false;
  const category = value as Record<string, unknown>;
  return isBoundedString(category.category, 256)
    && isFiniteNumber(category.share)
    && isFiniteNumber(category.change24h)
    && isFiniteNumber(category.activeCampaigns)
    && typeof category.trending === 'boolean';
}

function hasValidCategories(value: unknown): value is ProtoCategory[] {
  return Array.isArray(value)
    && value.length <= MAX_CATEGORY_ENTRIES
    && value.every(isValidCategory);
}

type GivingResponseInspection =
  | { kind: 'v2'; materializedAt: number }
  | { kind: 'legacy'; materializedAt?: undefined }
  | { kind: 'unavailable'; materializedAt?: undefined };

function inspectGivingResponse(
  response: ProtoResponse | null | undefined,
  now: number,
): GivingResponseInspection {
  if (!response?.dataAvailable || !response.summary) return { kind: 'unavailable' };

  const summary = response.summary;
  const hasV2Contract = GIVING_DATA_MODES.has(summary.dataMode as GivingDataMode)
    && hasValidGivingProvenance(summary.provenance)
    && typeof summary.activityIndexAvailable === 'boolean'
    && typeof summary.trendAvailable === 'boolean'
    && hasValidPlatforms(summary.platforms)
    && hasValidCategories(summary.categories);
  if (!hasV2Contract) return { kind: 'legacy' };

  const materializedAt = responseMaterializedAt(response);
  return isUsableMaterializationTime(materializedAt, now)
    ? { kind: 'v2', materializedAt }
    : { kind: 'unavailable' };
}

function toDisplayProvenance(proto: ProtoProvenance): GivingProvenance {
  return {
    subject: proto.subject,
    sourceName: proto.sourceName,
    sourceUrl: proto.sourceUrl,
    referencePeriod: proto.referencePeriod,
    sourcePublishedAt: proto.sourcePublishedAt,
    measurementBasis: proto.measurementBasis,
    status: normalizeGivingStatus(proto.status),
    coveredMetricPaths: [...proto.coveredMetricPaths],
    includedInHighlightedAggregate: proto.includedInHighlightedAggregate,
    reportedValue: proto.reportedValue,
    reportedUnit: proto.reportedUnit,
    notes: proto.notes,
    valueQualifier: proto.valueQualifier,
    sourceLocator: proto.sourceLocator,
    accessedAt: proto.accessedAt,
    denominator: proto.denominator,
    derivation: proto.derivation,
  };
}

function toDisplayPlatform(proto: ProtoPlatform): PlatformGiving {
  return {
    platform: proto.platform,
    dailyVolumeUsd: proto.dailyVolumeUsd,
    activeCampaignsSampled: proto.activeCampaignsSampled,
    newCampaigns24h: proto.newCampaigns24h,
    donationVelocity: proto.donationVelocity,
    dataFreshness: proto.dataFreshness,
    lastUpdated: proto.lastUpdated,
  };
}

function toDisplayCategory(proto: ProtoCategory): CategoryBreakdown {
  return {
    category: proto.category,
    share: proto.share,
    change24h: proto.change24h,
    activeCampaigns: proto.activeCampaigns,
    trending: proto.trending,
  };
}

function toDisplayCrypto(proto?: ProtoCrypto): CryptoGivingSummary {
  return {
    dailyInflowUsd: proto?.dailyInflowUsd ?? 0,
    trackedWallets: proto?.trackedWallets ?? 0,
    transactions24h: proto?.transactions24h ?? 0,
    topReceivers: proto?.topReceivers ?? [],
    pctOfTotal: proto?.pctOfTotal ?? 0,
  };
}

function toDisplayInstitutional(proto?: ProtoInstitutional): InstitutionalGiving {
  return {
    oecdOdaAnnualUsdBn: proto?.oecdOdaAnnualUsdBn ?? 0,
    oecdDataYear: proto?.oecdDataYear ?? 0,
    cafWorldGivingIndex: proto?.cafWorldGivingIndex ?? 0,
    cafDataYear: proto?.cafDataYear ?? 0,
    candidGrantsTracked: proto?.candidGrantsTracked ?? 0,
    dataLag: proto?.dataLag ?? '',
  };
}

function toDisplaySummary(response: ProtoResponse, materializedAt: number): GivingSummary {
  const summary = response.summary!;
  const provenance = summary.provenance.map(toDisplayProvenance);
  const dataMode = summary.dataMode as GivingDataMode;
  const incompleteEvidence = provenance.some((entry) =>
    entry.status === 'partially_verified' || entry.status === 'unverified');
  const availability: GivingAvailability =
    dataMode === 'published_estimate' && !incompleteEvidence
      ? 'available'
      : 'available-but-partial';

  return {
    generatedAt: summary.generatedAt,
    materializedAt: new Date(materializedAt).toISOString(),
    availability,
    refreshFailure: null,
    activityIndex: summary.activityIndex,
    activityIndexAvailable: summary.activityIndexAvailable,
    trend: summary.trend,
    trendAvailable: summary.trendAvailable,
    estimatedDailyFlowUsd: summary.estimatedDailyFlowUsd,
    platforms: summary.platforms.map(toDisplayPlatform),
    categories: summary.categories.map(toDisplayCategory),
    crypto: toDisplayCrypto(summary.crypto),
    institutional: toDisplayInstitutional(summary.institutional),
    dataMode,
    provenance,
  };
}

function toLegacyDisplaySummary(response: ProtoResponse, now: number): GivingSummary {
  const materializedAt = responseMaterializedAt(response);
  const materializedAtIso = materializedAt > 0 && materializedAt <= now + MAX_FUTURE_SKEW_MS
    ? new Date(materializedAt).toISOString()
    : '';
  const generatedAt = typeof response.summary?.generatedAt === 'string'
    ? response.summary.generatedAt
    : '';

  return {
    ...emptyResult,
    generatedAt,
    materializedAt: materializedAtIso,
    availability: 'available-but-legacy',
  };
}

export function classifyGivingResponse(
  response: ProtoResponse | null | undefined,
  now = Date.now(),
): GivingClassification {
  const inspection = inspectGivingResponse(response, now);
  if (inspection.kind === 'legacy') {
    return {
      kind: 'legacy',
      data: toLegacyDisplaySummary(response!, now),
    };
  }
  if (inspection.kind === 'unavailable') return { kind: 'unavailable' };

  return {
    kind: 'v2',
    snapshot: {
      data: toDisplaySummary(response!, inspection.materializedAt),
      materializedAt: inspection.materializedAt,
    },
  };
}

export function isCacheableGivingResponse(response: ProtoResponse): boolean {
  return inspectGivingResponse(response, Date.now()).kind === 'v2';
}

function unavailableResult(refreshFailure?: GivingRefreshFailure): GivingFetchResult {
  const data = {
    ...emptyResult,
    refreshFailure: refreshFailure ?? null,
  };
  return {
    ok: false,
    data,
    state: 'unavailable',
    refreshFailure,
  };
}

export function resolveGivingRefresh(
  response: ProtoResponse | null,
  lastGood: GivingSnapshot | null,
  now: number,
  refreshFailure: GivingRefreshFailure | null,
): GivingFetchResult {
  let legacyData: GivingSummary | null = null;
  if (response) {
    const classified = classifyGivingResponse(response, now);
    if (classified.kind === 'v2') {
      return {
        ok: true,
        data: classified.snapshot.data,
        state: classified.snapshot.data.availability,
        cachedAt: classified.snapshot.data.materializedAt,
      };
    }
    refreshFailure = classified.kind;
    if (classified.kind === 'legacy') legacyData = classified.data;
  }

  if (
    lastGood
    && isUsableMaterializationTime(lastGood.materializedAt, now)
    && refreshFailure
  ) {
    const data: GivingSummary = {
      ...lastGood.data,
      availability: 'cached-refresh-unavailable',
      refreshFailure,
    };
    return {
      ok: true,
      data,
      state: 'cached-refresh-unavailable',
      cachedAt: new Date(lastGood.materializedAt).toISOString(),
      refreshFailure,
    };
  }

  if (legacyData) {
    return {
      ok: true,
      data: legacyData,
      state: 'available-but-legacy',
      cachedAt: legacyData.materializedAt || undefined,
    };
  }

  return unavailableResult(refreshFailure ?? undefined);
}

export function resolveGivingHydration(
  response: ProtoResponse,
  source: GivingHydrationSource,
  now: number,
): GivingHydrationResolution {
  const classified = classifyGivingResponse(response, now);
  if (classified.kind === 'v2') {
    const hydrationIsLive = source === 'live';
    return {
      lastGood: classified.snapshot,
      immediateResult: hydrationIsLive
        ? resolveGivingRefresh(response, null, now, null)
        : null,
      // A cached/mixed bootstrap tier means its live refresh failed or was
      // incomplete. Keep that operational failure until a live v2 RPC clears it.
      refreshFailure: hydrationIsLive ? null : 'transport',
    };
  }

  if (classified.kind === 'legacy') {
    return {
      lastGood: null,
      immediateResult: source === 'live'
        ? resolveGivingRefresh(response, null, now, null)
        : null,
      refreshFailure: 'legacy',
    };
  }

  return {
    lastGood: null,
    immediateResult: null,
    refreshFailure: 'unavailable',
  };
}

export function formatCurrency(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export const __testing__ = {
  classifyGivingResponse,
  isCacheableGivingResponse,
  resolveGivingHydration,
  resolveGivingRefresh,
  GIVING_BREAKER_CACHE_KEY,
  GIVING_STALE_CEILING_MS,
};
