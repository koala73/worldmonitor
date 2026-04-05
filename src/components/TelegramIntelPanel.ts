import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren, safeHtml } from '@/utils/dom-utils';
import {
  TELEGRAM_TOPICS,
  fetchTelegramChannelFeed,
  fetchTelegramChannelPreview,
  formatTelegramTime,
  type TelegramChannelPreview,
  type TelegramFeedResponse,
  type TelegramItem,
} from '@/services/telegram-intel';
import {
  addTelegramWatchlistEntry,
  getTelegramWatchlistEntries,
  normalizeTelegramUsername,
  removeTelegramWatchlistEntry,
  subscribeTelegramWatchlistChange,
  type TelegramWatchlistEntry,
} from '@/services/telegram-watchlist';

const LIVE_THRESHOLD_MS = 600_000;
const WATCHLIST_PREVIEW_DEBOUNCE_MS = 800;
const WATCHLIST_BATCH_SIZE = 3;
const WATCHLIST_ITEM_LIMIT = 20;

type PreviewState = {
  channel: TelegramChannelPreview | null;
  error: string | null;
  loading: boolean;
  username: string;
};

function mergeTelegramItems(...groups: TelegramItem[][]): TelegramItem[] {
  const seen = new Set<string>();
  const items: TelegramItem[] = [];

  for (const group of groups) {
    for (const item of group) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export class TelegramIntelPanel extends Panel {
  private baseItems: TelegramItem[] = [];
  private watchlistItems: TelegramItem[] = [];
  private watchlistEntries: TelegramWatchlistEntry[] = getTelegramWatchlistEntries();
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private controlsEl: HTMLElement | null = null;
  private watchlistPillsEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private relayEnabled = true;
  private previewState: PreviewState = { channel: null, error: null, loading: false, username: '' };
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewRequestId = 0;
  private watchlistRequestId = 0;
  private unsubscribeWatchlist: (() => void) | null = null;

  constructor() {
    super({
      id: 'telegram-intel',
      title: t('panels.telegramIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.telegramIntel.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.createTabs();
    this.createControls();
    this.unsubscribeWatchlist = subscribeTelegramWatchlistChange(entries => {
      this.watchlistEntries = entries;
      this.renderWatchlistPills();
      this.renderPreview();
      void this.syncWatchlistFeed();
    });
    this.renderWatchlistPills();
    this.showLoading(t('components.telegramIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'panel-tabs' },
      ...TELEGRAM_TOPICS.map(topic =>
        h('button', {
          className: `panel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          onClick: () => this.selectTopic(topic.id),
        }, t(topic.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private createControls(): void {
    this.inputEl = h('input', {
      className: 'telegram-intel-input',
      type: 'text',
      placeholder: t('components.telegramIntel.watchlistPlaceholder'),
      'aria-label': t('components.telegramIntel.watchlistPlaceholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      onInput: () => this.queuePreviewResolve(),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.addPreviewChannel();
        }
      },
    }) as HTMLInputElement;

    this.previewEl = h('div', { className: 'telegram-intel-preview' });
    this.watchlistPillsEl = h('div', { className: 'telegram-intel-watchlist-pills' });
    this.controlsEl = h('div', { className: 'telegram-intel-controls' },
      h('div', { className: 'telegram-intel-input-row' }, this.inputEl),
      this.previewEl,
      this.watchlistPillsEl,
    );

    this.element.insertBefore(this.controlsEl, this.content);
  }

  private selectTopic(topicId: string): void {
    if (topicId === this.activeTopic) return;
    this.activeTopic = topicId;

    this.tabsEl?.querySelectorAll('.panel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    this.renderItems();
  }

  public setData(response: TelegramFeedResponse & { error?: string }): void {
    this.relayEnabled = response.enabled !== false;
    this.baseItems = response.items || [];

    if (this.inputEl) {
      this.inputEl.disabled = !this.relayEnabled;
    }

    if (!this.relayEnabled || response.error) {
      this.watchlistItems = [];
      this.setCount(0);
      replaceChildren(this.content,
        h('div', { className: 'empty-state error' },
          response.error || t('components.telegramIntel.disabled')
        ),
      );
      return;
    }

    void this.syncWatchlistFeed();
  }

  private queuePreviewResolve(): void {
    if (!this.inputEl) return;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }

    const raw = this.inputEl.value || '';
    const normalized = normalizeTelegramUsername(raw);
    const requestId = ++this.previewRequestId;

    if (!raw.trim()) {
      this.previewState = { channel: null, error: null, loading: false, username: '' };
      this.renderPreview();
      return;
    }

    this.previewState = { channel: null, error: null, loading: true, username: normalized || raw.trim() };
    this.renderPreview();

    this.previewTimer = setTimeout(async () => {
      if (requestId !== this.previewRequestId) return;

      if (!normalized) {
        this.previewState = {
          channel: null,
          error: t('components.telegramIntel.invalidUsername'),
          loading: false,
          username: raw.trim(),
        };
        this.renderPreview();
        return;
      }

      try {
        const channel = await fetchTelegramChannelPreview(normalized);
        if (requestId !== this.previewRequestId) return;
        this.previewState = { channel, error: null, loading: false, username: normalized };
      } catch {
        if (requestId !== this.previewRequestId) return;
        this.previewState = {
          channel: null,
          error: t('components.telegramIntel.resolveFailed'),
          loading: false,
          username: normalized,
        };
      }
      this.renderPreview();
    }, WATCHLIST_PREVIEW_DEBOUNCE_MS);
  }

  private renderPreview(): void {
    if (!this.previewEl) return;

    if (this.previewState.loading) {
      replaceChildren(this.previewEl,
        h('div', { className: 'telegram-intel-preview-card is-loading' },
          t('components.telegramIntel.resolving')
        ),
      );
      return;
    }

    if (this.previewState.error) {
      replaceChildren(this.previewEl,
        h('div', { className: 'telegram-intel-preview-card is-error' }, this.previewState.error),
      );
      return;
    }

    if (!this.previewState.channel) {
      replaceChildren(this.previewEl);
      return;
    }

    const channel = this.previewState.channel;
    const alreadyAdded = this.watchlistEntries.some(entry => entry.username === channel.username);
    const memberCopy = channel.memberCount == null
      ? ''
      : t('components.telegramIntel.previewMembers', {
        count: new Intl.NumberFormat().format(channel.memberCount),
      });

    replaceChildren(this.previewEl,
      h('div', { className: 'telegram-intel-preview-card' },
        h('div', { className: 'telegram-intel-preview-copy' },
          h('div', { className: 'telegram-intel-preview-title' }, channel.title),
          h('div', { className: 'telegram-intel-preview-meta' },
            `@${channel.username}`,
            memberCopy ? ` • ${memberCopy}` : '',
          ),
        ),
        alreadyAdded
          ? h('span', { className: 'telegram-intel-preview-status' }, t('components.telegramIntel.added'))
          : h('button', {
            type: 'button',
            className: 'telegram-follow-btn',
            onClick: () => void this.addPreviewChannel(),
          }, t('components.telegramIntel.addChannel')),
      ),
    );
  }

  private async addPreviewChannel(): Promise<void> {
    const channel = this.previewState.channel;
    if (!channel) return;

    addTelegramWatchlistEntry({ username: channel.username, title: channel.title });

    if (this.inputEl) {
      this.inputEl.value = '';
    }
    this.previewState = { channel: null, error: null, loading: false, username: '' };
    this.renderPreview();
  }

  private renderWatchlistPills(): void {
    if (!this.watchlistPillsEl) return;

    if (this.watchlistEntries.length === 0) {
      this.watchlistPillsEl.classList.add('is-empty');
      replaceChildren(this.watchlistPillsEl);
      return;
    }

    this.watchlistPillsEl.classList.remove('is-empty');
    replaceChildren(this.watchlistPillsEl,
      ...this.watchlistEntries.map(entry =>
        h('button', {
          type: 'button',
          className: 'telegram-intel-pill',
          onClick: () => removeTelegramWatchlistEntry(entry.username),
          title: `${t('components.telegramIntel.remove')} @${entry.username}`,
          'aria-label': `${t('components.telegramIntel.remove')} @${entry.username}`,
        },
        h('span', { className: 'telegram-intel-pill-label' }, `@${entry.username}`),
        h('span', { className: 'telegram-intel-pill-remove', 'aria-hidden': 'true' }, '×'),
        ),
      ),
    );
  }

  private async syncWatchlistFeed(): Promise<void> {
    const requestId = ++this.watchlistRequestId;

    if (!this.relayEnabled) {
      return;
    }

    if (this.watchlistEntries.length === 0) {
      this.watchlistItems = [];
      this.renderItems();
      return;
    }

    const items: TelegramItem[] = [];

    for (let index = 0; index < this.watchlistEntries.length; index += WATCHLIST_BATCH_SIZE) {
      const batch = this.watchlistEntries.slice(index, index + WATCHLIST_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(entry => fetchTelegramChannelFeed(entry.username, WATCHLIST_ITEM_LIMIT)),
      );

      if (requestId !== this.watchlistRequestId) return;

      for (const result of results) {
        if (result.status === 'fulfilled') {
          items.push(...result.value.items);
        } else {
          console.warn('[TelegramIntel] Watchlist channel fetch failed:', result.reason);
        }
      }
    }

    if (requestId !== this.watchlistRequestId) return;
    this.watchlistItems = mergeTelegramItems(items);
    this.renderItems();
  }

  private renderItems(): void {
    const mergedItems = mergeTelegramItems(this.watchlistItems, this.baseItems);
    const filtered = this.activeTopic === 'all'
      ? mergedItems
      : mergedItems.filter(item => item.topic === this.activeTopic);

    this.setCount(filtered.length);

    if (filtered.length === 0) {
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.empty')),
      );
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'telegram-intel-items' },
        ...filtered.map(item => this.buildItem(item)),
      ),
    );
  }

  private buildItem(item: TelegramItem): HTMLElement {
    const timeAgo = formatTelegramTime(item.ts);
    const itemDate = new Date(item.ts).getTime();
    const isLive = !Number.isNaN(itemDate) && (Date.now() - itemDate) < LIVE_THRESHOLD_MS;
    const raw = item.text || '';
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const textHtml = escaped.replace(/\n/g, '<br>');

    return h('div', { className: `telegram-intel-item ${isLive ? 'is-live' : ''}` },
      h('div', { className: 'telegram-intel-item-header' },
        h('div', { className: 'telegram-intel-channel-wrapper' },
          h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
          item.watchlist
            ? h('span', { className: 'telegram-intel-custom-tag' }, t('components.telegramIntel.custom'))
            : null,
          isLive ? h('span', { className: 'live-indicator' }, t('components.telegramIntel.live')) : null,
        ),
        h('div', { className: 'telegram-intel-meta' },
          h('span', { className: 'telegram-intel-topic' }, item.topic),
          h('span', { className: 'telegram-intel-time' }, timeAgo),
        ),
      ),
      h('div', { className: 'telegram-intel-text' }, safeHtml(textHtml)),
      item.mediaUrls && item.mediaUrls.length > 0 ? h('div', { className: 'telegram-intel-media-grid' },
        ...item.mediaUrls.map(url => {
          const isVideo = url.match(/\.(mp4|webm|mov)(\?.*)?$/i);
          if (isVideo) {
            return h('video', {
              className: 'telegram-intel-video',
              src: sanitizeUrl(url),
              controls: true,
              preload: 'metadata',
              playsinline: true,
            });
          }
          return h('img', {
            className: 'telegram-intel-image',
            src: sanitizeUrl(url),
            loading: 'lazy',
            onClick: () => window.open(sanitizeUrl(url), '_blank', 'noopener,noreferrer'),
          });
        })
      ) : null,
      h('div', { className: 'telegram-intel-item-actions' },
        h('a', {
          href: sanitizeUrl(item.url),
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'telegram-follow-btn',
        }, t('components.telegramIntel.viewSource')),
      ),
    );
  }

  public async refresh(): Promise<void> {
    // Handled by DataLoader + RefreshScheduler
  }

  public destroy(): void {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.unsubscribeWatchlist?.();
    this.unsubscribeWatchlist = null;

    if (this.controlsEl) {
      this.controlsEl.remove();
      this.controlsEl = null;
    }
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    super.destroy();
  }
}
