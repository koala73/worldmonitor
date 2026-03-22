import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNewsPriority,
  getPriorityScore,
  filterHighPriorityNews,
  NewsPriority,
} from '@/services/news-priority';
import type { NewsItem } from '@/types';

/**
 * Helper to create a mock NewsItem
 */
function createNewsItem(
  title: string,
  source = 'Test Source',
  pubDate: Date = new Date(),
): NewsItem {
  return {
    title,
    source,
    link: 'https://example.com/article',
    pubDate,
    isAlert: false,
  };
}

describe('news-priority', () => {
  describe('getNewsPriority', () => {
    it('returns P0 for funding news', () => {
      const article = createNewsItem(
        'Dublin startup Acme raises €5M Series A from NDRC',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P0 for acquisition news', () => {
      const article = createNewsItem(
        'Tech giant acquires Irish AI startup for $50M',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P0 for IPO news', () => {
      const article = createNewsItem('Irish fintech goes public on NYSE');
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P0 for Enterprise Ireland mentions', () => {
      const article = createNewsItem(
        'Enterprise Ireland backs new green tech initiative',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P1 for university research news', () => {
      const article = createNewsItem(
        'TCD announces breakthrough in quantum computing',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P1 for summit/conference news', () => {
      const article = createNewsItem(
        'Dublin Tech Summit 2026 announces keynote speakers',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P1 for big tech Ireland news', () => {
      const article = createNewsItem(
        'Google Dublin announces 500 new jobs',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P1 for semiconductor industry news', () => {
      const article = createNewsItem(
        'Analog Devices Limerick hiring 200 engineers for 5G chips',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P1 for Tyndall Institute news', () => {
      const article = createNewsItem(
        'Tyndall National Institute partners with Intel on quantum chip research',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P0 for EU Chips Act grants', () => {
      const article = createNewsItem(
        'EU Chips Act grant allocates €1.2 billion to Ireland semiconductor projects',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P0 for Intel large investment (€1B+)', () => {
      const article = createNewsItem(
        'Intel announces €4 billion expansion at Leixlip facility',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P0 for fab expansion', () => {
      const article = createNewsItem(
        'Intel fab expansion in Ireland to create 3000 jobs',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });

    it('returns P1 for Intel Ireland news without large investment', () => {
      const article = createNewsItem(
        'Intel Ireland showcases new 3nm chip technology',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P1 for EU Chips Act news without grant keyword', () => {
      const article = createNewsItem(
        'EU Chips Act impact on Ireland semiconductor industry',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P1);
    });

    it('returns P2 for regular news', () => {
      const article = createNewsItem('New coffee shop opens in Dublin');
      assert.equal(getNewsPriority(article), NewsPriority.P2);
    });

    it('is case insensitive', () => {
      const article = createNewsItem(
        'DUBLIN STARTUP RAISES €10M SERIES B',
      );
      assert.equal(getNewsPriority(article), NewsPriority.P0);
    });
  });

  describe('getPriorityScore', () => {
    it('gives higher score to P0 than P1', () => {
      const p0Article = createNewsItem('Startup raises €5M Series A');
      const p1Article = createNewsItem('TCD research breakthrough');

      const p0Score = getPriorityScore(p0Article);
      const p1Score = getPriorityScore(p1Article);

      assert.ok(p0Score > p1Score, 'P0 should have higher score than P1');
    });

    it('gives higher score to P1 than P2', () => {
      const p1Article = createNewsItem('TCD research breakthrough');
      const p2Article = createNewsItem('New coffee shop opens');

      const p1Score = getPriorityScore(p1Article);
      const p2Score = getPriorityScore(p2Article);

      assert.ok(p1Score > p2Score, 'P1 should have higher score than P2');
    });

    it('gives bonus for larger funding amounts', () => {
      const smallFunding = createNewsItem('Startup raises €5M Series A');
      const largeFunding = createNewsItem('Startup raises €50M Series B');

      const smallScore = getPriorityScore(smallFunding);
      const largeScore = getPriorityScore(largeFunding);

      assert.ok(
        largeScore > smallScore,
        'Larger funding should have higher score',
      );
    });

    it('gives bonus for recent articles', () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const recentArticle = createNewsItem('Startup raises €5M', 'Source', now);
      const oldArticle = createNewsItem('Startup raises €5M', 'Source', dayAgo);

      const recentScore = getPriorityScore(recentArticle);
      const oldScore = getPriorityScore(oldArticle);

      assert.ok(
        recentScore > oldScore,
        'Recent articles should have higher score',
      );
    });
  });

  describe('filterHighPriorityNews', () => {
    it('filters out P2 articles', () => {
      const articles = [
        createNewsItem('Startup raises €5M Series A'), // P0
        createNewsItem('TCD research breakthrough'), // P1
        createNewsItem('New coffee shop opens'), // P2
      ];

      const filtered = filterHighPriorityNews(articles);

      assert.equal(filtered.length, 2);
      assert.ok(
        filtered.every((a) => a.priority !== NewsPriority.P2),
        'Should not contain P2 articles',
      );
    });

    it('sorts by priority score descending', () => {
      const articles = [
        createNewsItem('TCD research breakthrough'), // P1
        createNewsItem('Startup raises €50M Series B'), // P0 with large amount
        createNewsItem('Web Summit keynote announced'), // P1
      ];

      const filtered = filterHighPriorityNews(articles);

      // P0 should be first due to base score + funding bonus
      assert.equal(filtered[0].priority, NewsPriority.P0);
    });

    it('respects limit parameter', () => {
      const articles = Array.from({ length: 20 }, (_, i) =>
        createNewsItem(`Startup raises €${i + 1}M Series A`),
      );

      const filtered = filterHighPriorityNews(articles, 5);

      assert.equal(filtered.length, 5);
    });

    it('returns empty array when no high priority news', () => {
      const articles = [
        createNewsItem('New coffee shop opens'),
        createNewsItem('Weather forecast for Dublin'),
        createNewsItem('Traffic update'),
      ];

      const filtered = filterHighPriorityNews(articles);

      assert.equal(filtered.length, 0);
    });

    it('adds priority and priorityScore to returned items', () => {
      const articles = [createNewsItem('Startup raises €5M Series A')];

      const filtered = filterHighPriorityNews(articles);

      assert.ok('priority' in filtered[0], 'Should have priority field');
      assert.ok(
        'priorityScore' in filtered[0],
        'Should have priorityScore field',
      );
      assert.equal(filtered[0].priority, NewsPriority.P0);
      assert.ok(
        typeof filtered[0].priorityScore === 'number',
        'priorityScore should be a number',
      );
    });

    it('defaults to limit of 10', () => {
      const articles = Array.from({ length: 20 }, (_, i) =>
        createNewsItem(`Startup raises €${i + 1}M Series A`),
      );

      const filtered = filterHighPriorityNews(articles);

      assert.equal(filtered.length, 10);
    });
  });
});
