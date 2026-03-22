/**
 * News Priority Service
 *
 * Determines the priority of news articles based on keywords and scoring.
 * Used by BreakingNewsTickerPanel to filter and display high-priority news.
 */

import type { NewsItem } from '@/types';

/**
 * News priority levels
 */
export enum NewsPriority {
  P0 = 'BREAKING', // Funding/Acquisition/IPO
  P1 = 'HOT', // University research/Summit/Big tech
  P2 = 'NEW', // Regular news (not displayed in ticker)
}

/**
 * Extended NewsItem with priority metadata
 */
export interface PriorityArticle extends NewsItem {
  priority: NewsPriority;
  priorityScore: number;
}

/**
 * P0 keywords - highest priority (funding, M&A, IPO)
 */
const P0_KEYWORDS = [
  'series a',
  'series b',
  'series c',
  'series d',
  'funding round',
  'raises €',
  'raises $',
  'raised €',
  'raised $',
  'secures €',
  'secures $',
  'acquisition',
  'acquires',
  'acquired',
  'm&a',
  'merger',
  'ipo',
  'goes public',
  'public offering',
  'enterprise ireland',
  'ndrc',
  'venture capital',
  'seed funding',
  'pre-seed',
];

/**
 * P0 keywords for semiconductor industry (major investments, fab expansion)
 * These require higher thresholds due to industry significance
 */
const SEMICONDUCTOR_P0_KEYWORDS = [
  'fab expansion',
  'chip plant',
  'wafer fab',
  'eu chips act grant',
  'chips act ireland',
  'chips act allocation',
  'billion semiconductor',
  'billion chip',
];

/**
 * P1 keywords - high priority (research, summits, big tech)
 */
const P1_KEYWORDS = [
  'tcd',
  'trinity college',
  'ucd',
  'university college dublin',
  'dcu',
  'nuig',
  'sfi',
  'science foundation ireland',
  'dublin tech summit',
  'web summit',
  'collision',
  'google dublin',
  'meta dublin',
  'apple ireland',
  'microsoft ireland',
  'amazon ireland',
  'intel ireland',
  'analog devices',
  'semiconductor ireland',
  'chip manufacturing',
  'eu chips act',
  'leixlip',
  'tyndall',
  'breakthrough',
  'research grant',
  'innovation hub',
  'tech hub',
  'startup hub',
];

/**
 * Check if article mentions large semiconductor investment (€500M+ or €1B+)
 */
function hasSemiconductorInvestment(text: string): boolean {
  // Check for Intel/semiconductor investment with large amounts
  const hasIntelOrChip = /intel|semiconductor|chip|fab/i.test(text);
  if (!hasIntelOrChip) return false;

  // Match €X billion/bn/b or €X million/m
  const billionMatch = text.match(/€\s*(\d+(?:\.\d+)?)\s*(?:billion|bn|b)\b/i);
  if (billionMatch && billionMatch[1]) {
    const amount = parseFloat(billionMatch[1]);
    if (amount >= 1) return true; // €1B+
  }

  const millionMatch = text.match(/€\s*(\d+(?:\.\d+)?)\s*(?:million|m)\b/i);
  if (millionMatch && millionMatch[1]) {
    const amount = parseFloat(millionMatch[1]);
    if (amount >= 500) return true; // €500M+
  }

  return false;
}

/**
 * Determine the priority of a news article based on keywords
 *
 * @param article - The news article to evaluate
 * @returns The priority level (P0, P1, or P2)
 */
export function getNewsPriority(article: NewsItem): NewsPriority {
  const text = article.title.toLowerCase();

  // Check P0 keywords first (highest priority)
  if (P0_KEYWORDS.some((kw) => text.includes(kw))) {
    return NewsPriority.P0;
  }

  // Check semiconductor P0 keywords (fab expansion, EU Chips Act grants)
  if (SEMICONDUCTOR_P0_KEYWORDS.some((kw) => text.includes(kw))) {
    return NewsPriority.P0;
  }

  // Check for large semiconductor investment (€500M+ or €1B+)
  if (hasSemiconductorInvestment(text)) {
    return NewsPriority.P0;
  }

  // Check P1 keywords
  if (P1_KEYWORDS.some((kw) => text.includes(kw))) {
    return NewsPriority.P1;
  }

  return NewsPriority.P2;
}

/**
 * Calculate a priority score for sorting articles
 * Higher scores appear first in the ticker
 *
 * @param article - The news article to score
 * @returns Numeric score (higher = more important)
 */
export function getPriorityScore(article: NewsItem): number {
  let score = 0;
  const text = article.title.toLowerCase();

  // Base score by priority
  const priority = getNewsPriority(article);
  if (priority === NewsPriority.P0) {
    score += 1000;
  } else if (priority === NewsPriority.P1) {
    score += 500;
  }

  // ====== Semiconductor company boost ======
  if (text.includes('intel ireland') || text.includes('intel leixlip')) {
    score += 200;
  }
  if (text.includes('analog devices')) {
    score += 150;
  }
  if (text.includes('eu chips act')) {
    score += 180;
  }

  // ====== Investment amount boost ======
  // Bonus for billions (€Xbn)
  const billionMatch = text.match(/€\s*(\d+(?:\.\d+)?)\s*(?:billion|bn|b)\b/i);
  if (billionMatch && billionMatch[1]) {
    const billions = parseFloat(billionMatch[1]);
    score += billions * 100; // €1B = +100 points
  }

  // Bonus for funding amounts (€Xm or $Xm)
  const moneyMatch = text.match(/[€$](\d+(?:\.\d+)?)\s*(?:m|million)/i);
  if (moneyMatch && moneyMatch[1]) {
    const amount = parseFloat(moneyMatch[1]);
    score += amount * 10;
  }

  // Bonus for recent articles (decay over 24 hours)
  const pubDate = article.pubDate ? new Date(article.pubDate).getTime() : Date.now();
  const ageMinutes = (Date.now() - pubDate) / 60000;
  score += Math.max(0, 1000 - ageMinutes);

  return score;
}

/**
 * Filter and sort high-priority news articles
 *
 * @param articles - Array of news articles to filter
 * @param limit - Maximum number of articles to return (default: 10)
 * @returns Filtered and sorted array of high-priority articles
 */
export function filterHighPriorityNews(
  articles: NewsItem[],
  limit = 10,
): PriorityArticle[] {
  return articles
    .map((article) => ({
      ...article,
      priority: getNewsPriority(article),
      priorityScore: getPriorityScore(article),
    }))
    .filter(
      (a) => a.priority === NewsPriority.P0 || a.priority === NewsPriority.P1,
    )
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, limit);
}
