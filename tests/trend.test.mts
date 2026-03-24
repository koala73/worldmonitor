/**
 * Trend Service Tests
 *
 * Tests for trend types, aggregation, and data generation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  TrendTopic,
  FundingTrend,
  FundingDataPoint,
  IndustryDistribution,
  TrendSummary,
  TrendPeriod,
} from '../src/types/trend.js';
import { TREND_LIMITS, TECH_KEYWORDS } from '../src/types/trend.js';
import { TrendAggregator } from '../src/services/trend/trend-aggregator.js';

describe('Trend Types', () => {
  it('TrendTopic should have required fields', () => {
    const topic: TrendTopic = {
      keyword: 'AI',
      count: 145,
      change: 25,
    };

    assert.equal(topic.keyword, 'AI');
    assert.equal(topic.count, 145);
    assert.equal(topic.change, 25);
  });

  it('FundingDataPoint should have required fields', () => {
    const dataPoint: FundingDataPoint = {
      date: '2026-03-24',
      amount: 50000000,
      deals: 3,
    };

    assert.equal(dataPoint.date, '2026-03-24');
    assert.equal(dataPoint.amount, 50000000);
    assert.equal(dataPoint.deals, 3);
  });

  it('FundingTrend should have required fields', () => {
    const funding: FundingTrend = {
      total: '€450M',
      deals: 12,
      averageDealSize: '€37.5M',
      timeline: [],
      weekOverWeek: 15,
    };

    assert.equal(funding.total, '€450M');
    assert.equal(funding.deals, 12);
    assert.equal(funding.averageDealSize, '€37.5M');
    assert.ok(Array.isArray(funding.timeline));
  });

  it('IndustryDistribution should have required fields', () => {
    const industry: IndustryDistribution = {
      name: 'Fintech',
      percentage: 28,
      newsCount: 120,
      fundingAmount: '€180M',
    };

    assert.equal(industry.name, 'Fintech');
    assert.equal(industry.percentage, 28);
    assert.equal(industry.newsCount, 120);
  });

  it('TrendSummary should have required fields', () => {
    const summary: TrendSummary = {
      totalNews: 450,
      totalFunding: '€450M',
      topIndustry: 'Fintech',
      trendingTopic: 'AI',
      weekOverWeek: { news: 15, funding: 10 },
      period: { start: '2026-02-24', end: '2026-03-24', days: 30 },
      updatedAt: '2026-03-24T00:00:00Z',
    };

    assert.equal(summary.totalNews, 450);
    assert.equal(summary.topIndustry, 'Fintech');
    assert.equal(summary.period.days, 30);
  });
});

describe('Trend Constants', () => {
  it('TREND_LIMITS should have correct values', () => {
    assert.equal(TREND_LIMITS.MAX_TOPICS, 20);
    assert.equal(TREND_LIMITS.DEFAULT_TOPICS, 10);
    assert.equal(TREND_LIMITS.CACHE_TTL_SECONDS, 3600);
    assert.deepEqual(TREND_LIMITS.VALID_PERIODS, [30, 90]);
  });

  it('TECH_KEYWORDS should contain common keywords', () => {
    assert.ok(TECH_KEYWORDS.includes('AI'));
    assert.ok(TECH_KEYWORDS.includes('funding'));
    assert.ok(TECH_KEYWORDS.includes('Dublin'));
    assert.ok(TECH_KEYWORDS.includes('fintech'));
    assert.ok(TECH_KEYWORDS.includes('semiconductor'));
  });
});

describe('TrendAggregator', () => {
  const aggregator = new TrendAggregator();

  describe('generateTopics', () => {
    it('should generate topics for 30-day period', () => {
      const topics = aggregator.generateTopics(30);

      assert.equal(topics.length, TREND_LIMITS.DEFAULT_TOPICS);
      for (const topic of topics) {
        assert.ok(topic.keyword);
        assert.ok(typeof topic.count === 'number');
        assert.ok(typeof topic.change === 'number');
      }
    });

    it('should generate topics for 90-day period with scaled counts', () => {
      const topics30 = aggregator.generateTopics(30);
      const topics90 = aggregator.generateTopics(90);

      // 90-day counts should be roughly 3x the 30-day counts
      assert.ok(topics90[0].count > topics30[0].count);
    });

    it('should respect limit parameter', () => {
      const topics5 = aggregator.generateTopics(30, 5);
      const topics15 = aggregator.generateTopics(30, 15);

      assert.equal(topics5.length, 5);
      assert.equal(topics15.length, 15);
    });

    it('should have AI as top topic', () => {
      const topics = aggregator.generateTopics(30);
      assert.equal(topics[0].keyword, 'AI');
    });
  });

  describe('generateFundingTrend', () => {
    it('should generate funding trend for 30-day period', () => {
      const funding = aggregator.generateFundingTrend(30);

      assert.ok(funding.total.startsWith('€'));
      assert.ok(funding.deals > 0);
      assert.ok(funding.averageDealSize.startsWith('€'));
      assert.ok(funding.timeline.length > 0);
      assert.ok(typeof funding.weekOverWeek === 'number');
    });

    it('should have valid timeline dates', () => {
      const funding = aggregator.generateFundingTrend(30);

      for (const point of funding.timeline) {
        assert.match(point.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(point.amount > 0);
        assert.ok(point.deals >= 1);
      }
    });

    it('should have more timeline points for 30-day vs 90-day', () => {
      const funding30 = aggregator.generateFundingTrend(30);
      const funding90 = aggregator.generateFundingTrend(90);

      // 30-day is daily (31 points), 90-day is weekly (13 points)
      assert.ok(funding30.timeline.length > funding90.timeline.length);
    });
  });

  describe('generateIndustryDistribution', () => {
    it('should generate industry distribution', () => {
      const industries = aggregator.generateIndustryDistribution(30);

      assert.ok(industries.length > 0);
      for (const industry of industries) {
        assert.ok(industry.name);
        assert.ok(industry.percentage > 0);
        assert.ok(industry.newsCount > 0);
      }
    });

    it('should have Fintech as top industry', () => {
      const industries = aggregator.generateIndustryDistribution(30);
      assert.equal(industries[0].name, 'Fintech');
    });

    it('should have percentages summing to ~100', () => {
      const industries = aggregator.generateIndustryDistribution(30);
      const total = industries.reduce((sum, i) => sum + i.percentage, 0);
      assert.equal(total, 100);
    });

    it('should scale news counts for 90-day period', () => {
      const industries30 = aggregator.generateIndustryDistribution(30);
      const industries90 = aggregator.generateIndustryDistribution(90);

      // 90-day counts should be 3x
      assert.equal(industries90[0].newsCount, industries30[0].newsCount * 3);
    });
  });

  describe('generateSummary', () => {
    it('should generate summary for 30-day period', () => {
      const summary = aggregator.generateSummary(30);

      assert.ok(summary.totalNews > 0);
      assert.ok(summary.totalFunding.startsWith('€'));
      assert.ok(summary.topIndustry);
      assert.ok(summary.trendingTopic);
      assert.ok(summary.weekOverWeek);
      assert.equal(summary.period.days, 30);
      assert.ok(summary.updatedAt);
    });

    it('should have valid date range', () => {
      const summary = aggregator.generateSummary(30);

      assert.match(summary.period.start, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(summary.period.end, /^\d{4}-\d{2}-\d{2}$/);

      const start = new Date(summary.period.start);
      const end = new Date(summary.period.end);
      const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

      assert.ok(diffDays >= 29 && diffDays <= 31);
    });

    it('should have AI as trending topic', () => {
      const summary = aggregator.generateSummary(30);
      assert.equal(summary.trendingTopic, 'AI');
    });
  });

  describe('isValidPeriod', () => {
    it('should accept valid periods', () => {
      assert.ok(aggregator.isValidPeriod(30));
      assert.ok(aggregator.isValidPeriod(90));
    });

    it('should reject invalid periods', () => {
      assert.ok(!aggregator.isValidPeriod(7));
      assert.ok(!aggregator.isValidPeriod(60));
      assert.ok(!aggregator.isValidPeriod(365));
    });
  });
});

describe('Currency Formatting', () => {
  function formatCurrency(amount: number): string {
    if (amount >= 1_000_000_000) return `€${(amount / 1_000_000_000).toFixed(1)}B`;
    if (amount >= 1_000_000) return `€${(amount / 1_000_000).toFixed(0)}M`;
    if (amount >= 1_000) return `€${(amount / 1_000).toFixed(0)}K`;
    return `€${amount}`;
  }

  it('should format billions', () => {
    assert.equal(formatCurrency(2_500_000_000), '€2.5B');
    assert.equal(formatCurrency(1_000_000_000), '€1.0B');
  });

  it('should format millions', () => {
    assert.equal(formatCurrency(450_000_000), '€450M');
    assert.equal(formatCurrency(1_500_000), '€2M');
  });

  it('should format thousands', () => {
    assert.equal(formatCurrency(500_000), '€500K');
    assert.equal(formatCurrency(50_000), '€50K');
  });

  it('should format small amounts', () => {
    assert.equal(formatCurrency(999), '€999');
    assert.equal(formatCurrency(0), '€0');
  });
});

describe('Date Range Calculation', () => {
  function getDateRange(days: number): { start: string; end: string } {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    return {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
    };
  }

  it('should calculate 30-day range', () => {
    const range = getDateRange(30);
    const start = new Date(range.start);
    const end = new Date(range.end);
    const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

    assert.ok(diff >= 29 && diff <= 31);
  });

  it('should calculate 90-day range', () => {
    const range = getDateRange(90);
    const start = new Date(range.start);
    const end = new Date(range.end);
    const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

    assert.ok(diff >= 89 && diff <= 91);
  });

  it('should return valid date format', () => {
    const range = getDateRange(30);
    assert.match(range.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(range.end, /^\d{4}-\d{2}-\d{2}$/);
  });
});
