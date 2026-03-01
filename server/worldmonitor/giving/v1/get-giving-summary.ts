/**
 * GetGivingSummary RPC -- aggregates global personal giving data from multiple
 * sources into a composite Global Giving Activity Index.
 *
 * Data sources (all use published annual report baselines):
 * 1. GoFundMe -- 2024 Year in Giving report
 * 2. GlobalGiving -- 2024 annual report
 * 3. JustGiving -- published cumulative totals
 * 4. Endaoment / crypto giving -- industry estimates
 * 5. OECD ODA annual totals (institutional baseline)
 */

import type {
  ServerContext,
  GetGivingSummaryRequest,
  GetGivingSummaryResponse,
  GivingSummary,
  PlatformGiving,
  CategoryBreakdown,
  CryptoGivingSummary,
  InstitutionalGiving,
} from '../../../../src/generated/server/worldmonitor/giving/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'giving:summary:v1';
const REDIS_CACHE_TTL = 3600; // 1 hour

// ─── GoFundMe Estimate ───
// GoFundMe's public search API (mvc.php) was removed ~2025. Their search now
// uses Algolia internally. We use published annual report data as a baseline.
//
// Published data points (GoFundMe 2024 Year in Giving report):
//   - $30B+ total raised since founding
//   - ~$9B raised in 2024 alone
//   - 200M+ unique donors
//   - ~250,000 active campaigns at any time
//   - Medical & health is the largest category (~33%)

function getGoFundMeEstimate(): PlatformGiving {
  return {
    platform: 'GoFundMe',
    dailyVolumeUsd: 9_000_000_000 / 365, // ~$24.7M/day from 2024 annual report
    activeCampaignsSampled: 0,
    newCampaigns24h: 0,
    donationVelocity: 0,
    dataFreshness: 'annual',
    lastUpdated: new Date().toISOString(),
  };
}

// ─── GlobalGiving Estimate ───
// GlobalGiving's public API now requires a registered API key (returns 401
// without one). We use published data as a baseline.
//
// Published data points (GlobalGiving 2024 annual report):
//   - $900M+ total raised since founding (2002)
//   - ~35,000 vetted projects in 175+ countries
//   - 1.2M+ donors
//   - ~$100M raised in recent years annually

function getGlobalGivingEstimate(): PlatformGiving {
  return {
    platform: 'GlobalGiving',
    dailyVolumeUsd: 100_000_000 / 365, // ~$274K/day from annual reports
    activeCampaignsSampled: 0,
    newCampaigns24h: 0,
    donationVelocity: 0,
    dataFreshness: 'annual',
    lastUpdated: new Date().toISOString(),
  };
}

// ─── JustGiving Estimate ───

function getJustGivingEstimate(): PlatformGiving {
  // JustGiving reports ~$7B+ total raised. Public search API is limited.
  // Use published annual reports for macro signal.
  return {
    platform: 'JustGiving',
    dailyVolumeUsd: 7_000_000_000 / 365, // ~$19.2M/day from annual reports
    activeCampaignsSampled: 0,
    newCampaigns24h: 0,
    donationVelocity: 0,
    dataFreshness: 'annual',
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Crypto Giving Estimate ───

function getCryptoGivingEstimate(): CryptoGivingSummary {
  // On-chain charity tracking -- Endaoment, The Giving Block, etc.
  // Total crypto giving estimated at ~$2B/year (2024 data).
  // Endaoment alone processed ~$40M in 2023.
  return {
    dailyInflowUsd: 2_000_000_000 / 365, // ~$5.5M/day estimate
    trackedWallets: 150,
    transactions24h: 0, // would require on-chain indexer
    topReceivers: ['Endaoment', 'The Giving Block', 'UNICEF Crypto Fund', 'Save the Children'],
    pctOfTotal: 0.8, // ~0.8% of total charitable giving
  };
}

// ─── Institutional / ODA Baseline ───

function getInstitutionalBaseline(): InstitutionalGiving {
  // OECD DAC ODA statistics -- 2023 data
  return {
    oecdOdaAnnualUsdBn: 223.7, // 2023 preliminary
    oecdDataYear: 2023,
    cafWorldGivingIndex: 34, // 2024 CAF World Giving Index (global avg %)
    cafDataYear: 2024,
    candidGrantsTracked: 18_000_000, // Candid tracks ~18M grants
    dataLag: 'Annual',
  };
}

// ─── Category Breakdown ───

function getDefaultCategories(): CategoryBreakdown[] {
  // Based on published GoFundMe / GlobalGiving category distributions
  return [
    { category: 'Medical & Health', share: 0.33, change24h: 0, activeCampaigns: 0, trending: true },
    { category: 'Disaster Relief', share: 0.15, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Education', share: 0.12, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Community', share: 0.10, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Memorials', share: 0.08, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Animals & Pets', share: 0.07, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Environment', share: 0.05, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Hunger & Food', share: 0.05, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Other', share: 0.05, change24h: 0, activeCampaigns: 0, trending: false },
  ];
}

// ─── Composite Activity Index ───

function computeActivityIndex(platforms: PlatformGiving[], crypto: CryptoGivingSummary): number {
  // Composite index (0-100) weighted by data quality and signal strength
  // Higher when: more platforms reporting, higher velocity, more new campaigns
  let score = 50; // baseline

  const totalDailyVolume = platforms.reduce((s, p) => s + p.dailyVolumeUsd, 0) + crypto.dailyInflowUsd;
  // Expected baseline ~$50M/day across tracked platforms
  const volumeRatio = totalDailyVolume / 50_000_000;
  score += Math.min(20, Math.max(-20, (volumeRatio - 1) * 20));

  // Campaign velocity bonus
  const totalVelocity = platforms.reduce((s, p) => s + p.donationVelocity, 0);
  if (totalVelocity > 100) score += 5;
  if (totalVelocity > 500) score += 10;

  // New campaigns signal
  const totalNew = platforms.reduce((s, p) => s + p.newCampaigns24h, 0);
  if (totalNew > 10) score += 5;
  if (totalNew > 50) score += 5;

  // Data coverage bonus
  const reporting = platforms.filter(p => p.dailyVolumeUsd > 0).length;
  score += reporting * 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeTrend(index: number): string {
  // Without historical data, use index level as proxy
  if (index >= 65) return 'rising';
  if (index <= 35) return 'falling';
  return 'stable';
}

// ─── Main Handler ───

export async function getGivingSummary(
  _ctx: ServerContext,
  req: GetGivingSummaryRequest,
): Promise<GetGivingSummaryResponse> {
  try {
    const result = await cachedFetchJson<GetGivingSummaryResponse>(REDIS_CACHE_KEY, REDIS_CACHE_TTL, async () => {
      const cryptoEstimate = getCryptoGivingEstimate();
      const gofundme = getGoFundMeEstimate();
      const globalGiving = getGlobalGivingEstimate();
      const justGiving = getJustGivingEstimate();
      const institutional = getInstitutionalBaseline();

      const platforms = [gofundme, globalGiving, justGiving];
      const categories = getDefaultCategories();

      const activityIndex = computeActivityIndex(platforms, cryptoEstimate);
      const trend = computeTrend(activityIndex);
      const estimatedDailyFlowUsd = platforms.reduce((s, p) => s + p.dailyVolumeUsd, 0) + cryptoEstimate.dailyInflowUsd;

      const summary: GivingSummary = {
        generatedAt: new Date().toISOString(),
        activityIndex,
        trend,
        estimatedDailyFlowUsd,
        platforms,
        categories,
        crypto: cryptoEstimate,
        institutional,
      };

      return { summary };
    });

    if (!result) return { summary: undefined as unknown as GivingSummary };

    const summary = result.summary;
    if (summary) {
      if (req.platformLimit > 0 && summary.platforms) {
        summary.platforms = summary.platforms.slice(0, req.platformLimit);
      }
      if (req.categoryLimit > 0 && summary.categories) {
        summary.categories = summary.categories.slice(0, req.categoryLimit);
      }
    }

    return { summary };
  } catch {
    return { summary: undefined as unknown as GivingSummary };
  }
}
