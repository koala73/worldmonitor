/**
 * Alert Matcher Service
 *
 * Matches incoming news articles against user alerts.
 * Determines priority and triggers notifications.
 */

import type {
  AlertNewsItem,
  AlertPriority,
  AlertMatch,
} from '@/types/smart-alert';
import { alertStorage } from './alert-storage';

/**
 * Keywords that indicate high-priority news
 */
const PRIORITY_KEYWORDS: Record<AlertPriority, string[]> = {
  CRITICAL: [
    'funding', 'raises', 'series a', 'series b', 'series c', 'series d',
    'acquisition', 'acquired', 'merger', 'm&a', 'ipo', 'goes public',
    'bankruptcy', 'layoffs', 'shutdown', 'closes', 'data breach', 'hack',
  ],
  HIGH: [
    'expansion', 'expands', 'new office', 'headquarters', 'hq',
    'hiring', 'jobs', 'employees', 'ceo', 'cto', 'cfo', 'executive',
    'partnership', 'partners with', 'collaboration', 'launch', 'launches',
  ],
  NORMAL: [],
};

/**
 * Determine the priority of a news article
 */
export function determineNewsPriority(news: AlertNewsItem): AlertPriority {
  const text = `${news.title} ${news.content || ''} ${news.tags.join(' ')}`.toLowerCase();

  // Check for critical keywords
  for (const kw of PRIORITY_KEYWORDS.CRITICAL) {
    if (text.includes(kw)) return 'CRITICAL';
  }

  // Check for high keywords
  for (const kw of PRIORITY_KEYWORDS.HIGH) {
    if (text.includes(kw)) return 'HIGH';
  }

  return 'NORMAL';
}

/**
 * Check if a keyword matches the news article
 */
function matchesKeyword(news: AlertNewsItem, keyword: string): boolean {
  const lowerKeyword = keyword.toLowerCase();
  const searchText = `${news.title} ${news.content || ''} ${news.source}`.toLowerCase();

  // Simple contains match
  if (searchText.includes(lowerKeyword)) return true;

  // Check tags
  if (news.tags.some(tag => tag.toLowerCase().includes(lowerKeyword))) return true;

  return false;
}

/**
 * Alert Matcher class for matching news to alerts
 */
export class AlertMatcher {
  /**
   * Match a news article against all active alerts
   * Returns list of matches with user profiles for notification
   */
  async matchNews(news: AlertNewsItem): Promise<AlertMatch[]> {
    const matches: AlertMatch[] = [];
    const newsPriority = determineNewsPriority(news);

    // Get all active alerts
    // Note: In production, this should be optimized with an inverted index
    const allAlerts = await alertStorage.getAllActiveAlerts();

    for (const { alert, userProfile } of allAlerts) {
      // Skip inactive alerts
      if (!alert.isActive) continue;

      // Check keyword match
      if (!matchesKeyword(news, alert.keyword)) continue;

      // Check priority filter
      if (!alert.priorityFilter.includes(newsPriority)) continue;

      // Check rate limit (1 notification per hour per alert)
      const recentlyNotified = await alertStorage.wasRecentlyNotified(alert.id);
      if (recentlyNotified) continue;

      // Skip if no user profile for delivery
      if (!userProfile) continue;

      // Skip if no delivery channel configured
      const hasEmail = userProfile.email && alert.channels.includes('email');
      const hasTelegram = userProfile.telegramChatId && alert.channels.includes('telegram');
      if (!hasEmail && !hasTelegram) continue;

      matches.push({
        alert,
        userProfile,
        priority: newsPriority,
        matchedKeywords: [alert.keyword],
      });
    }

    return matches;
  }

  /**
   * Match news against a specific user's alerts (for testing/preview)
   */
  async matchNewsForUser(news: AlertNewsItem, userId: string): Promise<AlertMatch[]> {
    const matches: AlertMatch[] = [];
    const newsPriority = determineNewsPriority(news);

    const alerts = await alertStorage.listAlerts(userId);
    const userProfile = await alertStorage.getUserProfile(userId);

    for (const alert of alerts) {
      if (!alert.isActive) continue;
      if (!matchesKeyword(news, alert.keyword)) continue;
      if (!alert.priorityFilter.includes(newsPriority)) continue;

      matches.push({
        alert,
        userProfile: userProfile || { userId, preferences: { digestMode: false } },
        priority: newsPriority,
        matchedKeywords: [alert.keyword],
      });
    }

    return matches;
  }

  /**
   * Test if a keyword would match a piece of text
   * Used for preview/validation in UI
   */
  testKeywordMatch(text: string, keyword: string): boolean {
    const mockNews: AlertNewsItem = {
      id: 'test',
      title: text,
      url: '',
      source: '',
      tags: [],
      publishedAt: new Date().toISOString(),
    };
    return matchesKeyword(mockNews, keyword);
  }
}

// Export singleton instance
export const alertMatcher = new AlertMatcher();
