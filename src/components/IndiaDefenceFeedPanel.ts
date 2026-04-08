import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

interface CategoryMeta { label: string; icon: string; color: string; }
interface TweetCategory { category: string; score: number; }
interface Tweet {
  id: string;
  handle: string;
  accountName: string;
  text: string;
  publishedAt: string;
  url: string;
  source: string;
  tier: number;
  primaryCategory: string;
  categories: TweetCategory[];
  metrics?: { retweet_count?: number; like_count?: number; reply_count?: number };
}
interface FeedResponse {
  tweets: Tweet[];
  total: number;
  categoryCounts: Record<string, number>;
  categories: Record<string, CategoryMeta>;
  accounts: { handle: string; name: string; tier: number }[];
  source: string;
  dataNote: string | null;
  fetchedAt: string;
}

type ActiveCat = string; // 'all' | category key

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const BATCH_COUNT = 7; // 7 batches × 15 accounts = 105 (covers all 95)

export class IndiaDefenceFeedPanel extends Panel {
  private activeCategory: ActiveCat = 'all';
  private searchQuery = '';
  private allTweets: Tweet[] = [];
  private categoriesMeta: Record<string, CategoryMeta> = {};
  private categoryCounts: Record<string, number> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private loadedBatches = new Set<number>();
  private isLoadingMore = false;
  private lastFetchedAt = '';

  constructor() {
    super({ id: 'india-defence-feed', title: 'India Defence Feed', showCount: true });
    void this.loadInitialFeed();
    this.refreshTimer = setInterval(() => void this.loadInitialFeed(true), REFRESH_INTERVAL_MS);
  }

  private async loadInitialFeed(forceRefresh = false): Promise<void> {
    if (this.allTweets.length === 0) this.showLoading('Fetching India defence tweets…');
    try {
      const url = `/api/india-defence-feed?limit=80${forceRefresh ? '&refresh=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FeedResponse;
      this.categoriesMeta = data.categories ?? {};
      this.categoryCounts = data.categoryCounts ?? {};
      this.lastFetchedAt = data.fetchedAt ?? '';
      // Merge new tweets, deduplicate
      this.mergeTweets(data.tweets ?? []);
      this.loadedBatches.add(-1);
      if (data.dataNote && this.allTweets.length === 0) {
        this.showError(data.dataNote);
        return;
      }
      this.render();
      // Load remaining batches in background
      void this.loadRemainingBatches();
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (this.allTweets.length === 0) this.showError('Failed to load defence feed. Check TWITTER_BEARER_TOKEN or Nitter connectivity.');
    }
  }

  private async loadRemainingBatches(): Promise<void> {
    if (this.isLoadingMore) return;
    this.isLoadingMore = true;
    for (let b = 0; b < BATCH_COUNT; b++) {
      if (this.loadedBatches.has(b)) continue;
      try {
        const res = await fetch(`/api/india-defence-feed?batch=${b}&limit=80`);
        if (!res.ok) continue;
        const data = (await res.json()) as FeedResponse;
        this.mergeTweets(data.tweets ?? []);
        this.loadedBatches.add(b);
        // Update category counts
        for (const [k, v] of Object.entries(data.categoryCounts ?? {})) {
          this.categoryCounts[k] = (this.categoryCounts[k] ?? 0) + v;
        }
        this.render();
      } catch { /* skip failed batch */ }
    }
    this.isLoadingMore = false;
  }

  private mergeTweets(incoming: Tweet[]): void {
    const existing = new Set(this.allTweets.map(t => t.id));
    const novel = incoming.filter(t => !existing.has(t.id));
    this.allTweets = [...this.allTweets, ...novel]
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  private get filteredTweets(): Tweet[] {
    let list = this.allTweets;
    if (this.activeCategory !== 'all') {
      list = list.filter(t => t.categories.some(c => c.category === this.activeCategory));
    }
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(t =>
        t.text.toLowerCase().includes(q) ||
        t.handle.toLowerCase().includes(q) ||
        t.accountName.toLowerCase().includes(q)
      );
    }
    return list;
  }

  private render(): void {
    const tweets = this.filteredTweets;
    this.setCount(tweets.length);

    const allCount = this.allTweets.length;
    const catKeys = ['all', ...Object.keys(this.categoriesMeta)];

    // Category tabs
    const tabs = h('div', { className: 'idf-tabs' },
      ...catKeys.map(cat => {
        const meta = cat === 'all' ? null : this.categoriesMeta[cat];
        const count = cat === 'all' ? allCount : (this.categoryCounts[cat] ?? 0);
        return h('button', {
          className: `idf-tab${this.activeCategory === cat ? ' active' : ''}`,
          style: this.activeCategory === cat && meta ? `border-color:${meta.color};color:${meta.color}` : '',
          onclick: () => { this.activeCategory = cat; this.render(); },
        },
          meta ? h('span', { className: 'idf-tab-icon' }, meta.icon) : null,
          h('span', { className: 'idf-tab-label' }, cat === 'all' ? 'All' : (meta?.label ?? cat)),
          count > 0 ? h('span', { className: 'idf-tab-count' }, String(count)) : null
        );
      })
    );

    // Search + meta bar
    const searchInput = h('input', {
      type: 'text',
      className: 'idf-search',
      placeholder: '🔍 Search tweets, handles…',
      value: this.searchQuery,
      oninput: (e: Event) => { this.searchQuery = (e.target as HTMLInputElement).value; this.render(); },
    });

    const metaBar = h('div', { className: 'idf-meta-bar' },
      searchInput,
      h('span', { className: 'idf-meta-source' },
        this.isLoadingMore ? '⟳ Loading more accounts…' :
        this.lastFetchedAt ? `Updated ${this.formatRelativeTime(this.lastFetchedAt)}` : ''
      ),
      h('button', {
        className: 'idf-refresh-btn',
        title: 'Refresh feed',
        onclick: () => void this.loadInitialFeed(true),
      }, '↻ Refresh')
    );

    // Feed
    const cards = tweets.slice(0, 60).map(t => this.renderTweetCard(t));
    const feedEl = h('div', { className: 'idf-feed' }, ...cards);

    const empty = tweets.length === 0
      ? h('div', { className: 'idf-empty' },
          h('p', {}, this.allTweets.length === 0
            ? 'No tweets loaded yet. The feed is fetching live data…'
            : `No tweets match "${this.searchQuery || this.activeCategory}" category.`
          )
        )
      : null;

    replaceChildren(this.content, tabs, metaBar, empty ?? feedEl);
  }

  private renderTweetCard(tweet: Tweet): HTMLElement {
    const cats = tweet.categories.slice(0, 2);
    const tweetMeta = this.categoriesMeta;
    const safeUrl = sanitizeUrl(tweet.url);
    const initials = tweet.handle.slice(0, 2).toUpperCase();
    const timeStr = this.formatRelativeTime(tweet.publishedAt);

    const catBadges = cats.map(c => {
      const meta = tweetMeta[c.category];
      if (!meta) return null;
      return h('span', {
        className: 'idf-cat-badge',
        style: `background:${meta.color}22;color:${meta.color};border:1px solid ${meta.color}44`,
      }, `${meta.icon} ${meta.label}`);
    });

    const avatar = h('div', {
      className: 'idf-avatar',
      style: `background:${this.handleColor(tweet.handle)}`,
    }, initials);

    const metricsEl = tweet.metrics
      ? h('div', { className: 'idf-metrics' },
          tweet.metrics.retweet_count != null ? h('span', {}, `🔁 ${tweet.metrics.retweet_count}`) : null,
          tweet.metrics.like_count != null ? h('span', {}, `❤️ ${tweet.metrics.like_count}`) : null,
          tweet.metrics.reply_count != null ? h('span', {}, `💬 ${tweet.metrics.reply_count}`) : null,
        )
      : null;

    const sourceBadge = tweet.source === 'twitter_api'
      ? h('span', { className: 'idf-source-badge idf-source-api' }, 'API')
      : h('span', { className: 'idf-source-badge idf-source-nitter' }, 'RSS');

    return h('article', { className: `idf-tweet-card tier-${tweet.tier}` },
      h('div', { className: 'idf-tweet-left' }, avatar),
      h('div', { className: 'idf-tweet-body' },
        h('div', { className: 'idf-tweet-header' },
          h('span', { className: 'idf-tweet-name' }, escapeHtml(tweet.accountName)),
          h('span', { className: 'idf-tweet-handle' }, `@${escapeHtml(tweet.handle)}`),
          h('span', { className: 'idf-tweet-time' }, timeStr),
          sourceBadge,
        ),
        h('p', { className: 'idf-tweet-text' }, escapeHtml(tweet.text)),
        h('div', { className: 'idf-tweet-footer' },
          h('div', { className: 'idf-cat-badges' }, ...catBadges.filter(Boolean) as HTMLElement[]),
          metricsEl,
          safeUrl ? h('a', {
            className: 'idf-tweet-link',
            href: safeUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, 'View on X →') : null,
        )
      )
    );
  }

  private formatRelativeTime(iso: string): string {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    } catch { return ''; }
  }

  /** Deterministic color from handle string */
  private handleColor(handle: string): string {
    const colors: string[] = ['#1e40af', '#166534', '#991b1b', '#6b21a8', '#92400e', '#0f766e', '#854d0e'];
    let hv = 0;
    for (let i = 0; i < handle.length; i++) hv = (hv * 31 + handle.charCodeAt(i)) >>> 0;
    return colors[hv % colors.length] as string;
  }

  public refresh(): void { void this.loadInitialFeed(true); }

  public destroy(): void {
    if (this.refreshTimer !== null) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }
}
