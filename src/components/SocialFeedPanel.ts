/**
 * SocialFeedPanel — Unified social media intelligence panel.
 *
 * Extends Panel base class with vanilla DOM (h() helper, NOT JSX).
 * Platform filter tabs: All | Reddit | X | Bluesky | YouTube | TikTok | VK
 * Content rendered as textContent (never innerHTML) for XSS safety.
 * Sliding window: max 100 posts in memory with deduplication by post ID.
 */

import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import { createErrorDisplay } from './sentinel/error-display';
import { createDataFreshnessIndicator, type FreshnessStatus } from './sentinel/DataFreshnessIndicator';
import {
  fetchAllSocialFeeds,
  formatSocialTime,
  SOCIAL_PLATFORMS,
  type SocialPost,
  type SocialPlatform,
  type AllSocialFeedsResult,
} from '@/services/social';

const MAX_POSTS_IN_MEMORY = 100;

export class SocialFeedPanel extends Panel {
  private posts: SocialPost[] = [];
  private seenIds = new Set<string>();
  private activeFilter: SocialPlatform | 'all' = 'all';
  private tabsEl: HTMLElement | null = null;
  private freshnessEl: HTMLElement | null = null;
  private lastUpdated: string | null = null;
  private platformErrors: Map<string, string> = new Map();

  constructor() {
    super({
      id: 'social-feed',
      title: t('sentinel.socialFeed.title'),
      showCount: true,
      trackActivity: true,
    });
    this.createFreshnessIndicator('loading');
    this.createTabs();
    this.showLoading(t('sentinel.socialFeed.loading'));
  }

  private createFreshnessIndicator(status: FreshnessStatus): void {
    if (this.freshnessEl) {
      this.freshnessEl.remove();
    }
    this.freshnessEl = createDataFreshnessIndicator(status, this.lastUpdated);
    this.element.insertBefore(this.freshnessEl, this.header.nextSibling);
  }

  private createTabs(): void {
    const allTab = { id: 'all' as const, labelKey: 'sentinel.socialFeed.filterAll' };
    const tabs = [allTab, ...SOCIAL_PLATFORMS];

    this.tabsEl = h('div', { className: 'social-feed-tabs' },
      ...tabs.map(tab =>
        h('button', {
          className: `social-feed-tab ${tab.id === this.activeFilter ? 'active' : ''}`,
          dataset: { platformId: tab.id },
          onClick: () => this.selectFilter(tab.id as SocialPlatform | 'all'),
        }, t(tab.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectFilter(platformId: SocialPlatform | 'all'): void {
    if (platformId === this.activeFilter) return;
    this.activeFilter = platformId;

    this.tabsEl?.querySelectorAll('.social-feed-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.platformId === platformId);
    });

    this.renderPosts();
  }

  public setData(result: AllSocialFeedsResult): void {
    this.lastUpdated = result.lastUpdated;

    // Track platform errors
    this.platformErrors.clear();
    for (const err of result.errors) {
      this.platformErrors.set(err.platform, err.error);
    }

    // Deduplication + sliding window
    for (const post of result.posts) {
      if (!this.seenIds.has(post.id)) {
        this.seenIds.add(post.id);
        this.posts.push(post);
      }
    }

    // Enforce sliding window: keep most recent MAX_POSTS_IN_MEMORY
    if (this.posts.length > MAX_POSTS_IN_MEMORY) {
      const removed = this.posts.splice(0, this.posts.length - MAX_POSTS_IN_MEMORY);
      for (const p of removed) {
        this.seenIds.delete(p.id);
      }
    }

    // Sort by timestamp descending
    this.posts.sort((a, b) => b.timestamp - a.timestamp);

    // Update freshness indicator
    const hasErrors = this.platformErrors.size > 0;
    const hasData = this.posts.length > 0;
    const status: FreshnessStatus = hasData ? (hasErrors ? 'cached' : 'live') : (hasErrors ? 'unavailable' : 'live');
    this.createFreshnessIndicator(status);

    this.renderPosts();
  }

  private renderPosts(): void {
    const filtered = this.activeFilter === 'all'
      ? this.posts
      : this.posts.filter(p => p.platform === this.activeFilter);

    this.setCount(filtered.length);

    if (filtered.length === 0) {
      const message = this.platformErrors.size > 0
        ? t('sentinel.socialFeed.error')
        : t('sentinel.socialFeed.empty');
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, message),
      );
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'social-feed-items' },
        ...filtered.map(post => this.buildPostItem(post)),
      ),
    );
  }

  private buildPostItem(post: SocialPost): HTMLElement {
    const timeAgo = formatSocialTime(post.timestamp);
    const safeUrl = sanitizeUrl(post.url);

    const item = h('a', {
      href: safeUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      className: `social-feed-item social-feed-item--${post.platform}`,
    },
      h('div', { className: 'social-feed-item-header' },
        h('span', { className: 'social-feed-platform' }, this.platformLabel(post.platform)),
        h('span', { className: 'social-feed-author' }, post.author),
        h('span', { className: 'social-feed-time' }, timeAgo),
      ),
      h('div', { className: 'social-feed-text' }, post.content),
      h('div', { className: 'social-feed-meta' },
        post.engagement > 0
          ? h('span', { className: 'social-feed-engagement' }, `${post.engagement}`)
          : null,
        post.subreddit
          ? h('span', { className: 'social-feed-subreddit' }, `r/${post.subreddit}`)
          : null,
        post.hashtags
          ? h('span', { className: 'social-feed-hashtags' }, post.hashtags)
          : null,
      ),
    );

    // Content rendered as textContent (safe) — individual child nodes
    // already use text nodes via h() helper, not innerHTML

    return item;
  }

  private platformLabel(platform: string): string {
    const labels: Record<string, string> = {
      reddit: 'Reddit',
      twitter: 'X',
      bluesky: 'Bluesky',
      youtube: 'YouTube',
      tiktok: 'TikTok',
      vk: 'VK',
    };
    return labels[platform] ?? platform;
  }

  public showDisabled(): void {
    this.setCount(0);
    this.createFreshnessIndicator('unavailable');
    replaceChildren(this.content,
      h('div', { className: 'empty-state' }, t('sentinel.socialFeed.disabled')),
    );
  }

  public showError(error: Error | string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      createErrorDisplay('SocialFeed', this.content, err);
    } catch {
      super.showError(t('sentinel.socialFeed.error'));
    }
  }

  public async refresh(): Promise<void> {
    try {
      this.createFreshnessIndicator('loading');
      const result = await fetchAllSocialFeeds();
      this.setData(result);
    } catch (err) {
      this.showError(err as Error);
    }
  }

  public destroy(): void {
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    if (this.freshnessEl) {
      this.freshnessEl.remove();
      this.freshnessEl = null;
    }
    this.posts = [];
    this.seenIds.clear();
    this.platformErrors.clear();
    super.destroy();
  }
}
