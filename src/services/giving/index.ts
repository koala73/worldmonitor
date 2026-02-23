import {
  GivingServiceClient,
  type GetGivingSummaryResponse as ProtoResponse,
  type GivingSummary as ProtoSummary,
  type PlatformGiving as ProtoPlatform,
  type CategoryBreakdown as ProtoCategory,
  type CryptoGivingSummary as ProtoCrypto,
  type InstitutionalGiving as ProtoInstitutional,
} from '@/generated/client/worldmonitor/giving/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// ─── Consumer-friendly types ───

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
  activityIndex: number;
  trend: 'rising' | 'stable' | 'falling';
  estimatedDailyFlowUsd: number;
  platforms: PlatformGiving[];
  categories: CategoryBreakdown[];
  crypto: CryptoGivingSummary;
  institutional: InstitutionalGiving;
}

export interface GivingFetchResult {
  ok: boolean;
  data: GivingSummary;
  cachedAt?: string;
}

// ─── Proto -> display mapping ───

function toDisplaySummary(proto: ProtoResponse): GivingSummary {
  const s = proto.summary!;
  return {
    generatedAt: s.generatedAt,
    activityIndex: s.activityIndex,
    trend: s.trend as 'rising' | 'stable' | 'falling',
    estimatedDailyFlowUsd: s.estimatedDailyFlowUsd,
    platforms: s.platforms.map(toDisplayPlatform),
    categories: s.categories.map(toDisplayCategory),
    crypto: toDisplayCrypto(s.crypto),
    institutional: toDisplayInstitutional(s.institutional),
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
    dataLag: proto?.dataLag ?? 'Unknown',
  };
}

// ─── Client + circuit breaker ───

const client = new GivingServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const emptyResult: GivingSummary = {
  generatedAt: new Date().toISOString(),
  activityIndex: 0,
  trend: 'stable',
  estimatedDailyFlowUsd: 0,
  platforms: [],
  categories: [],
  crypto: { dailyInflowUsd: 0, trackedWallets: 0, transactions24h: 0, topReceivers: [], pctOfTotal: 0 },
  institutional: { oecdOdaAnnualUsdBn: 0, oecdDataYear: 0, cafWorldGivingIndex: 0, cafDataYear: 0, candidGrantsTracked: 0, dataLag: 'Unknown' },
};

const breaker = createCircuitBreaker<GivingSummary>({
  name: 'Global Giving',
});

// ─── Main fetch (public API) ───

export async function fetchGivingSummary(): Promise<GivingFetchResult> {
  const data = await breaker.execute(async () => {
    const response = await client.getGivingSummary({
      platformLimit: 0,
      categoryLimit: 0,
    });
    return toDisplaySummary(response);
  }, emptyResult);

  return {
    ok: data !== emptyResult && data.platforms.length > 0,
    data,
  };
}

// ─── Presentation helpers ───

export function formatCurrency(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function getActivityColor(index: number): string {
  if (index >= 70) return 'var(--semantic-positive)';
  if (index >= 50) return 'var(--accent)';
  if (index >= 30) return 'var(--semantic-elevated)';
  return 'var(--semantic-critical)';
}

export function getTrendIcon(trend: string): string {
  if (trend === 'rising') return '\u25B2'; // ▲
  if (trend === 'falling') return '\u25BC'; // ▼
  return '\u25CF'; // ●
}

export function getTrendColor(trend: string): string {
  if (trend === 'rising') return 'var(--semantic-positive)';
  if (trend === 'falling') return 'var(--semantic-critical)';
  return 'var(--text-muted)';
}
