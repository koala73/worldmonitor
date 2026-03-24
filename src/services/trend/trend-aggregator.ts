/**
 * Trend Aggregator Service
 *
 * Generates trend data for the dashboard.
 * V1 uses mock data; future versions will aggregate from news DB.
 */

import type {
  TrendTopic,
  FundingTrend,
  FundingDataPoint,
  IndustryDistribution,
  TrendSummary,
  TrendPeriod,
} from '@/types/trend';
import { TREND_LIMITS } from '@/types/trend';

/**
 * Format currency amount
 */
function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) {
    return `€${(amount / 1_000_000_000).toFixed(1)}B`;
  }
  if (amount >= 1_000_000) {
    return `€${(amount / 1_000_000).toFixed(0)}M`;
  }
  if (amount >= 1_000) {
    return `€${(amount / 1_000).toFixed(0)}K`;
  }
  return `€${amount}`;
}

/**
 * Get date range for period
 */
function getDateRange(days: TrendPeriod): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const startDate = start.toISOString().split('T')[0] ?? '';
  const endDate = end.toISOString().split('T')[0] ?? '';

  return {
    start: startDate,
    end: endDate,
  };
}

/**
 * Generate mock timeline data
 */
function generateTimeline(days: TrendPeriod): FundingDataPoint[] {
  const timeline: FundingDataPoint[] = [];
  const end = new Date();
  const interval = days === 30 ? 1 : 7; // Daily for 30 days, weekly for 90

  for (let i = days; i >= 0; i -= interval) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);

    // Generate realistic-looking random data
    const baseFunding = 10_000_000 + Math.random() * 90_000_000;
    const deals = Math.floor(1 + Math.random() * 4);

    timeline.push({
      date: date.toISOString().split('T')[0] ?? '',
      amount: Math.round(baseFunding),
      deals,
    });
  }

  return timeline;
}

/**
 * Trend Aggregator class
 */
export class TrendAggregator {
  /**
   * Generate mock topics data
   * In production, this would extract keywords from news articles
   */
  generateTopics(days: TrendPeriod, limit = TREND_LIMITS.DEFAULT_TOPICS): TrendTopic[] {
    const mockTopics: TrendTopic[] = [
      { keyword: 'AI', count: 145 + Math.floor(Math.random() * 30), change: 25 },
      { keyword: 'funding', count: 98 + Math.floor(Math.random() * 20), change: 12 },
      { keyword: 'Dublin', count: 87 + Math.floor(Math.random() * 15), change: 5 },
      { keyword: 'fintech', count: 76 + Math.floor(Math.random() * 15), change: 18 },
      { keyword: 'expansion', count: 65 + Math.floor(Math.random() * 10), change: -3 },
      { keyword: 'hiring', count: 58 + Math.floor(Math.random() * 10), change: 8 },
      { keyword: 'semiconductor', count: 52 + Math.floor(Math.random() * 10), change: 15 },
      { keyword: 'startup', count: 48 + Math.floor(Math.random() * 10), change: 2 },
      { keyword: 'cloud', count: 45 + Math.floor(Math.random() * 10), change: 10 },
      { keyword: 'acquisition', count: 42 + Math.floor(Math.random() * 10), change: -5 },
      { keyword: 'data center', count: 38 + Math.floor(Math.random() * 8), change: 20 },
      { keyword: 'EMEA', count: 35 + Math.floor(Math.random() * 8), change: 3 },
      { keyword: 'IPO', count: 28 + Math.floor(Math.random() * 5), change: -8 },
      { keyword: 'unicorn', count: 25 + Math.floor(Math.random() * 5), change: 5 },
      { keyword: 'Cork', count: 22 + Math.floor(Math.random() * 5), change: 12 },
    ];

    // Scale counts based on period
    const scale = days === 90 ? 3 : 1;

    return mockTopics.slice(0, limit).map((t) => ({
      ...t,
      count: t.count * scale,
    }));
  }

  /**
   * Generate mock funding trend data
   */
  generateFundingTrend(days: TrendPeriod): FundingTrend {
    const timeline = generateTimeline(days);

    // Calculate totals
    const totalAmount = timeline.reduce((sum, d) => sum + d.amount, 0);
    const totalDeals = timeline.reduce((sum, d) => sum + d.deals, 0);

    return {
      total: formatCurrency(totalAmount),
      deals: totalDeals,
      averageDealSize: formatCurrency(totalAmount / totalDeals),
      timeline,
      weekOverWeek: Math.round(-10 + Math.random() * 30), // -10% to +20%
    };
  }

  /**
   * Generate mock industry distribution
   */
  generateIndustryDistribution(days: TrendPeriod): IndustryDistribution[] {
    const scale = days === 90 ? 3 : 1;

    return [
      { name: 'Fintech', percentage: 28, newsCount: 120 * scale, fundingAmount: '€180M' },
      { name: 'AI/ML', percentage: 22, newsCount: 95 * scale, fundingAmount: '€150M' },
      { name: 'SaaS', percentage: 18, newsCount: 78 * scale, fundingAmount: '€80M' },
      { name: 'Cloud', percentage: 12, newsCount: 52 * scale, fundingAmount: '€45M' },
      { name: 'Semiconductor', percentage: 10, newsCount: 43 * scale, fundingAmount: '€120M' },
      { name: 'Healthcare', percentage: 6, newsCount: 26 * scale, fundingAmount: '€25M' },
      { name: 'Other', percentage: 4, newsCount: 17 * scale },
    ];
  }

  /**
   * Generate summary
   */
  generateSummary(days: TrendPeriod): TrendSummary {
    const topics = this.generateTopics(days, 1);
    const funding = this.generateFundingTrend(days);
    const industries = this.generateIndustryDistribution(days);
    const range = getDateRange(days);

    const totalNews = industries.reduce((sum, i) => sum + i.newsCount, 0);

    return {
      totalNews,
      totalFunding: funding.total,
      topIndustry: industries[0]?.name ?? 'Unknown',
      trendingTopic: topics[0]?.keyword ?? 'Unknown',
      weekOverWeek: {
        news: Math.round(-5 + Math.random() * 20),
        funding: funding.weekOverWeek,
      },
      period: {
        start: range.start,
        end: range.end,
        days,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate period parameter
   */
  isValidPeriod(days: number): days is TrendPeriod {
    return TREND_LIMITS.VALID_PERIODS.includes(days as TrendPeriod);
  }
}

// Export singleton
export const trendAggregator = new TrendAggregator();
